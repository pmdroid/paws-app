import { ask as rawAsk } from "../questions";
import type { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { FakeClock } from "../core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  enterMergeQueue,
  getWorkItem,
  insertQueuedItem,
  migrate,
  openDatabase,
  saveCheckpoint,
  type TaskMergeSettings,
} from "../db";
import {
  createFakeGitHub,
  defaultGitExec,
  fakeMergeReadiness,
  fakeRequiredChecks,
  type FakeMergeQueue,
  type GitHubClient,
  type GitHubResponse,
  type ReverifyInput,
} from "../github";
import { advanceMerge, type MergeCapabilities, type MergeVerdict } from "./advance";
import type { MergeStep } from "./step";

const exec = promisify(execFile);

type CheckNodes = ReturnType<
  typeof fakeMergeReadiness
>["data"]["repository"]["object"]["statusCheckRollup"]["contexts"]["nodes"];

export type Line = { kind: "thought" | "status" | "afterPullRequest"; body: string };

export type HarnessItem = {
  id: string;
  worktree: string;
  pull: number;
  accepted: string;
  base: string;
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["-C", cwd, ...args])).stdout.trim();
}

async function identity(dir: string): Promise<void> {
  await git(dir, "config", "user.email", "paws-test@example.com");
  await git(dir, "config", "user.name", "Paws Test");
  await git(dir, "config", "commit.gpgsign", "false");
}

export const LOG_TAIL = "bun test v1.4.2\n✗ formats an empty list\n 1 fail";

export function failingTest(): CheckNodes {
  return [
    { name: "lint", conclusion: "SUCCESS", detailsUrl: "https://ci.example/0" },
    {
      name: "test",
      conclusion: "FAILURE",
      detailsUrl: "https://ci.example/1",
      databaseId: 77,
      checkSuite: { app: { slug: "github-actions" } },
    },
    { name: "e2e", conclusion: null, detailsUrl: "https://ci.example/2" },
  ];
}

export function pendingCi(): CheckNodes {
  return [{ name: "ci", conclusion: null, detailsUrl: null }];
}

export async function mergeHarness(
  options: {
    settings?: Partial<Pick<TaskMergeSettings, "order" | "mainMoved">>;
    queue?: FakeMergeQueue;
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "paws-advance-"));
  const bare = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  await exec("git", ["init", "--bare", "-b", "main", bare]);
  await exec("git", ["clone", "-q", bare, seed]);
  await identity(seed);
  await writeFile(path.join(seed, "README.md"), "demo\n");
  await writeFile(path.join(seed, "ok.txt"), "base\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-qm", "init");
  await git(seed, "push", "-q", "origin", "HEAD:main");

  const db: Database = openDatabase(":memory:");
  migrate(db);
  const clock = new FakeClock(1_000_000);
  const github = createFakeGitHub();
  const items = new Map<string, HarnessItem>();
  const payloads = new Map<string, Record<string, unknown>>();
  const lines: Line[] = [];
  const keys = new Set<string>();
  const verified: ReverifyInput[] = [];
  const accepted: { sha: string; baseSha: string }[] = [];
  const closeoutHelp: string[] = [];
  const completed: string[] = [];
  const settings: Pick<TaskMergeSettings, "order" | "mainMoved"> = {
    order: options.settings?.order ?? "ci-green",
    mainMoved: options.settings?.mainMoved ?? "closeout",
  };
  const state = {
    ci: (_head: string): CheckNodes | undefined => undefined,
    pullHead: (head: string): string => head,
    reviews: new Map<number, "REVIEW_REQUIRED" | "CHANGES_REQUESTED" | "APPROVED">(),
    upToDateRule: false,
    verdict: { accepted: true, outcome: "merged", summary: "Re-verified.", rejected: false } as
      | MergeVerdict
      | (() => MergeVerdict),
    ciFixAttempts: 3,
    stopped: false,
    orders: new Map<string, TaskMergeSettings["order"]>(),
  };
  let jobId = 0;

  const client: GitHubClient = {
    async request(req): Promise<GitHubResponse> {
      const queued = await options.queue?.respond(req);
      if (queued) return queued;
      if (req.path.endsWith("/actions/jobs/77/logs")) return { status: 200, body: `${LOG_TAIL}\n` };
      if (req.path === "/graphql") {
        const variables = (req.body as { variables: { number: number; head?: string } }).variables;
        if (variables.head === undefined)
          return {
            status: 200,
            body: {
              data: {
                repository: {
                  pullRequest: { reviewDecision: state.reviews.get(variables.number) ?? null },
                },
              },
            },
          };
        const body = fakeMergeReadiness(variables.head);
        const nodes = state.ci(variables.head);
        if (nodes) body.data.repository.object.statusCheckRollup.contexts.nodes = nodes;
        body.data.repository.pullRequest.headRefOid = state.pullHead(variables.head);
        return { status: 200, body };
      }
      if (state.upToDateRule && req.method === "GET" && req.path.includes("/rules/branches/"))
        return {
          status: 200,
          body: [
            {
              type: "required_status_checks",
              parameters: { strict_required_status_checks_policy: true },
            },
          ],
        };
      const required = fakeRequiredChecks(req);
      if (required) return required;
      if (req.method === "PUT" && req.path.endsWith("/merge")) {
        const body = req.body as { sha: string; commit_title: string };
        const number = Number(req.path.split("/").at(-2));
        const result = await github.merge({
          repository: "acme/app",
          number,
          expectedHeadSha: body.sha,
        });
        return { status: 200, body: { sha: result.sha, merged: true } };
      }
      return { status: 404, body: {} };
    },
  };

  async function addItem(
    id: string,
    change: { file?: string; content?: string } = {},
  ): Promise<HarnessItem> {
    const worktree = path.join(root, id);
    await exec("git", ["clone", "-q", bare, worktree]);
    await identity(worktree);
    await git(worktree, "checkout", "-qb", `paws/${id}`);
    await writeFile(path.join(worktree, change.file ?? `${id}.txt`), change.content ?? `${id}\n`);
    await git(worktree, "add", ".");
    await git(worktree, "commit", "-qm", `${id} change`);
    await git(worktree, "push", "-q", "origin", `HEAD:paws/${id}`);
    const head = await git(worktree, "rev-parse", "HEAD");
    const base = await git(worktree, "rev-parse", "origin/main");
    insertQueuedItem(db, { id, now: clock.now(), sessionKey: `ses-${id}` });
    beginImplementRun(db, id, clock.now());
    enterMergeQueue(db, id, { phase: "merge_queue", baseSha: base, wipCommit: head });
    const item = { id, worktree, pull: items.size + 1, accepted: head, base };
    items.set(id, item);
    payloads.set(id, { itemId: id, head, summary: "Closeout accepted." });
    return item;
  }

  async function requeue(id: string, fix?: string): Promise<string> {
    const item = items.get(id)!;
    if (fix !== undefined) {
      await writeFile(path.join(item.worktree, `${id}.txt`), fix);
      await git(item.worktree, "commit", "-qam", `${id} fix`);
      await git(item.worktree, "push", "-qf", "origin", `HEAD:paws/${id}`);
    }
    const head = await git(item.worktree, "rev-parse", "HEAD");
    const current = getWorkItem(db, id)!;
    if (current.state === "queued") applyWorkItemEvent(db, id, "dispatched");
    applyWorkItemEvent(db, id, "turn_ended");
    applyWorkItemEvent(db, id, "closeout_accepted");
    saveCheckpoint(db, id, { ...current.checkpoint!, phase: "merge_queue", wipCommit: head });
    payloads.set(id, { itemId: id, head, summary: "Closeout accepted." });
    return head;
  }

  async function remoteHead(id: string): Promise<string> {
    return git(bare, "rev-parse", `refs/heads/paws/${id}`);
  }

  async function moveMain(file: string, content: string): Promise<string> {
    await git(seed, "pull", "-q", "--ff-only", "origin", "main");
    await writeFile(path.join(seed, file), content);
    await git(seed, "add", ".");
    await git(seed, "commit", "-qm", `main changes ${file}`);
    await git(seed, "push", "-q", "origin", "HEAD:main");
    return git(seed, "rev-parse", "HEAD");
  }

  function capabilities(id: string): MergeCapabilities {
    const item = items.get(id)!;
    return {
      ask,
      now: () => clock.now(),
      stopped: () => state.stopped,
      session: (current) => current.sessionKey,
      fetchMain: async () => {
        await git(item.worktree, "fetch", "-q", bare, "+refs/heads/main:refs/paws/upstream-main");
        return git(item.worktree, "rev-parse", "refs/paws/upstream-main");
      },
      ciFixAttempts: () => state.ciFixAttempts,
      voice: {
        thought: (_, body, key) => say("thought", body, key),
        status: (_, body, key) => say("status", body, key),
        afterPullRequest: (_, body, key) => say("afterPullRequest", body, key),
        flush: async () => {},
      },
      publish: async (current) => ({
        github: {
          appId: "1",
          installationId: "2",
          privateKeyPem: "unused",
          client,
          tokenProvider: { mode: "app", tokenFor: async () => "ghs_test" },
          gitExec: defaultGitExec(),
        },
        repository: { owner: "acme", repo: "app", remoteUrl: bare },
        pull: { number: item.pull, url: `https://github.com/acme/app/pull/${item.pull}` },
        head: current.checkpoint?.wipCommit ?? item.accepted,
        signal: new AbortController().signal,
        worktree: item.worktree,
        branchKey: id,
        summary: "Closeout accepted.",
        commit: { title: `${id} change` },
      }),
      settings: async () => ({
        ...settings,
        order: state.orders.get(id) ?? settings.order,
        resolved: {},
      }),
      accept: (candidate) => accepted.push(candidate),
      verify: async (input) => {
        verified.push(input);
        return typeof state.verdict === "function" ? state.verdict() : state.verdict;
      },
      assertReady: async () => {},
      askCloseoutHelp: async (current) => {
        closeoutHelp.push(current.id);
      },
      packages: () => [],
      completed: () => completed.push(id),
    };
  }

  function say(kind: Line["kind"], body: string, key: string): void {
    if (keys.has(key)) return;
    keys.add(key);
    lines.push({ kind, body });
  }

  async function pass(id: string): Promise<MergeStep> {
    jobId += 1;
    const payload = payloads.get(id)!;
    const step = await advanceMerge(db, { itemId: id, payload, jobId }, capabilities(id));
    if (step.kind === "wait")
      payloads.set(id, {
        ...payload,
        mergeWait: { reason: step.reason },
        ...(step.base === undefined ? {} : { ciWaitBase: step.base }),
        ...(step.head === undefined ? {} : { ciWaitHead: step.head }),
        ...(step.summary === undefined ? {} : { ciWaitSummary: step.summary }),
        ...(step.githubQueue === undefined ? {} : { githubQueue: step.githubQueue }),
      });
    return step;
  }

  return {
    db,
    clock,
    github,
    bare,
    state,
    settings,
    lines,
    verified,
    accepted,
    closeoutHelp,
    completed,
    addItem,
    requeue,
    remoteHead,
    moveMain,
    pass,
    git,
    bodies: (kind?: Line["kind"]) =>
      lines.filter((line) => kind === undefined || line.kind === kind).map((line) => line.body),
    cleanup: async () => {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export type MergeHarness = Awaited<ReturnType<typeof mergeHarness>>;

const ask: typeof rawAsk = (db, asker, ...args) => {
  const result = rawAsk(db, asker, ...args);
  if (getWorkItem(db, asker.itemId)?.state !== "awaiting_input")
    applyWorkItemEvent(db, asker.itemId, "blocking_question");
  return result;
};
