import { ask as rawAsk } from "../questions";
import type { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { FakeClock } from "../core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  enterMergeQueue,
  finishCloseoutProgress,
  getConfirmedRemoteMerge,
  getWorkItem,
  insertQueuedItem,
  markCloseoutAccepted,
  markRun,
  migrate,
  openDatabase,
  recordItemPullRequest,
  saveCheckpoint,
  type TaskMergeSettings,
} from "../db";
import {
  createFakeGitHub,
  defaultGitExec,
  fakeMergeReadiness,
  fakeRequiredChecks,
  readPullMergeable,
  type FakeMergeQueue,
  type GitHubClient,
  type GitHubResponse,
} from "../github";
import { advanceMerge, type MergeCapabilities } from "./advance";
import type { RiskApproval } from "./mergeable";
import { returnQueuedConflicts } from "./queue-conflicts";
import type { MergeStep } from "./step";

const exec = promisify(execFile);

/** The policy digest the harness's Closeout runs record. */
export const CLOSEOUT_DIGEST = "sha256:harness-policy";

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
  /** Heads Closeout ran on after the lane sent the item back to verifying. */
  const verified: string[] = [];
  const completed: string[] = [];
  const settings: Pick<TaskMergeSettings, "order" | "mainMoved"> = {
    order: options.settings?.order ?? "ci-green",
    mainMoved: options.settings?.mainMoved ?? "closeout",
  };
  const state = {
    ci: (_head: string): CheckNodes | undefined => undefined,
    /** The checks on main's head; none by default. */
    baseCi: (): CheckNodes | undefined => undefined,
    pullHead: (head: string): string => head,
    reviews: new Map<number, "REVIEW_REQUIRED" | "CHANGES_REQUESTED" | "APPROVED">(),
    /** The digest the lane reads now; acceptances record {@link CLOSEOUT_DIGEST}. */
    policyDigest: CLOSEOUT_DIGEST as string | null,
    ciFixAttempts: 3,
    stopped: false,
    orders: new Map<string, TaskMergeSettings["order"]>(),
    /** GitHub's "Require branches to be up to date before merging" on main. */
    upToDateRule: false,
    packages: [] as string[],
    /** The risk approval the lane reads for head S; normal tier unless a test says otherwise. */
    risk: (_head: string): RiskApproval => "not_required",
    /** Heads the lane asked a person to approve. */
    riskAsked: [] as string[],
    /** Each task's Linear blockers; a blocker releases it once its merge is confirmed. */
    blockedBy: new Map<string, string[]>(),
    /** Pull requests a person merged on GitHub, by number, with the merge commit. */
    handMerged: new Map<number, string>(),
    /** Lane reads of GitHub's merge state for the task's pull request before it reports one. */
    handMergeSeenAfter: 0,
    /** GitHub merges the pull request, but its answer to the merge call never arrives. */
    dropMergeResponse: false,
    /** GitHub's `mergeable` before it has computed one: null reads to answer first, per pull. */
    lazyMergeable: new Map<number, number>(),
    /** Pull request reads, by number. */
    pullReads: new Map<number, number>(),
    /** Held open while a squash is in flight; the squash goes on when it settles. */
    squashGate: null as Promise<void> | null,
    squashing: false,
  };
  /** Tasks the lane published, in order: every lane attempt past the dependency check. */
  const publishedIds: string[] = [];
  /** Tasks whose lane turn asked GitHub whether their pull request merged by hand. */
  const handMergeReads: string[] = [];
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
        const baseNodes = state.baseCi();
        if (baseNodes)
          body.data.repository.pullRequest.baseRef.target.statusCheckRollup.contexts.nodes =
            baseNodes;
        body.data.repository.pullRequest.headRefOid = state.pullHead(variables.head);
        if (state.handMerged.has(variables.number))
          (body.data.repository.pullRequest as { state: string }).state = "MERGED";
        return { status: 200, body };
      }
      if (state.upToDateRule && req.method === "GET" && req.path.includes("/rules/branches/main"))
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
      const pull = /^\/repos\/acme\/app\/pulls\/(\d+)$/.exec(req.path);
      if (req.method === "GET" && pull) return readPull(Number(pull[1]));
      if (req.method === "PUT" && req.path.endsWith("/merge")) {
        state.squashing = true;
        await state.squashGate;
        const body = req.body as { sha: string; commit_title: string };
        const number = Number(req.path.split("/").at(-2));
        const result = await github.merge({
          repository: "acme/app",
          number,
          expectedHeadSha: body.sha,
        });
        if (state.dropMergeResponse) {
          state.handMerged.set(number, result.sha);
          throw new Error("The connection closed before GitHub answered.");
        }
        return { status: 200, body: { sha: result.sha, merged: true } };
      }
      return { status: 404, body: {} };
    },
  };

  /** GitHub's pull request read: `mergeable` from whether the branch merges into main. */
  async function readPull(number: number): Promise<GitHubResponse> {
    state.pullReads.set(number, (state.pullReads.get(number) ?? 0) + 1);
    const id = [...items.values()].find((item) => item.pull === number)?.id;
    if (id === undefined) return { status: 404, body: {} };
    const head = await git(bare, "rev-parse", `refs/heads/paws/${id}`);
    const lazy = state.lazyMergeable.get(number) ?? 0;
    if (lazy > 0) {
      state.lazyMergeable.set(number, lazy - 1);
      return {
        status: 200,
        body: { state: "open", mergeable: null, mergeable_state: "unknown", head: { sha: head } },
      };
    }
    const merges = await exec("git", [
      "-C",
      bare,
      "merge-tree",
      "--write-tree",
      "refs/heads/main",
      `refs/heads/paws/${id}`,
    ]).then(
      () => true,
      () => false,
    );
    return {
      status: 200,
      body: {
        state: "open",
        mergeable: merges,
        mergeable_state: merges ? "behind" : "dirty",
        head: { sha: head },
      },
    };
  }

  async function addItem(
    id: string,
    change: { file?: string; content?: string } = {},
  ): Promise<HarnessItem> {
    const worktree = path.join(root, id);
    await exec("git", ["clone", "-q", bare, worktree]);
    await identity(worktree);
    await git(worktree, "checkout", "-qb", `paws/${id}`);
    const file = path.join(worktree, change.file ?? `${id}.txt`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, change.content ?? `${id}\n`);
    await git(worktree, "add", ".");
    await git(worktree, "commit", "-qm", `${id} change`);
    await git(worktree, "push", "-q", "origin", `HEAD:paws/${id}`);
    const head = await git(worktree, "rev-parse", "HEAD");
    const base = await git(worktree, "rev-parse", "origin/main");
    insertQueuedItem(db, { id, now: clock.now(), sessionKey: `ses-${id}` });
    const { run } = beginImplementRun(db, id, clock.now());
    enterMergeQueue(db, id, { phase: "merge_queue", baseSha: base, wipCommit: head });
    // The implementer run ends once Closeout accepts, as it does in the loop.
    markRun(db, run.id, "ended", clock.now());
    acceptHead(id, base, head);
    const item = { id, worktree, pull: items.size + 1, accepted: head, base };
    items.set(id, item);
    recordItemPullRequest(db, {
      itemId: id,
      pullNumber: item.pull,
      pullUrl: `https://github.com/acme/app/pull/${item.pull}`,
      openedAt: clock.now(),
    });
    payloads.set(id, { itemId: id, head, summary: "Closeout accepted." });
    return item;
  }

  /** Closeout's accept row: the accepted head and a finished run on it under the policy digest. */
  function acceptHead(id: string, base: string, head: string): void {
    finishCloseoutProgress(
      db,
      id,
      { taskId: id, base, head, policyDigest: CLOSEOUT_DIGEST, policyPath: null },
      "accepted",
      clock.now(),
    );
    markCloseoutAccepted(db, id, head);
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
    acceptHead(id, current.checkpoint?.baseSha ?? "", head);
    payloads.set(id, { itemId: id, head, summary: "Closeout accepted." });
    return head;
  }

  /** What the reverify job does for an item the lane sent back: Closeout accepts its head. */
  async function closeout(id: string): Promise<string> {
    const item = items.get(id)!;
    const head = await git(item.worktree, "rev-parse", "HEAD");
    const base = await git(item.worktree, "rev-parse", "refs/paws/upstream-main");
    verified.push(head);
    if (getWorkItem(db, id)?.state === "verifying") applyWorkItemEvent(db, id, "closeout_accepted");
    saveCheckpoint(db, id, { phase: "merge_queue", baseSha: base, wipCommit: head });
    acceptHead(id, base, head);
    payloads.set(id, { itemId: id, head, summary: "Closeout accepted." });
    return head;
  }

  async function remoteHead(id: string): Promise<string> {
    return git(bare, "rev-parse", `refs/heads/paws/${id}`);
  }

  async function moveMain(file: string, content: string): Promise<string> {
    await git(seed, "pull", "-q", "--ff-only", "origin", "main");
    await mkdir(path.dirname(path.join(seed, file)), { recursive: true });
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
      dependencyHold: (itemId) => {
        const open = (state.blockedBy.get(itemId) ?? []).filter(
          (blocker) => getConfirmedRemoteMerge(db, blocker) === null,
        );
        return open.length ? open : null;
      },
      voice: {
        thought: (_, body, key) => say("thought", body, key),
        status: (_, body, key) => say("status", body, key),
        afterPullRequest: (_, body, key) => say("afterPullRequest", body, key),
        flush: async () => {},
      },
      publish: async (current) => {
        publishedIds.push(current.id);
        return {
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
        };
      },
      settings: async () => ({
        ...settings,
        order: state.orders.get(id) ?? settings.order,
        resolved: {},
      }),
      policyDigest: () => state.policyDigest,
      packages: () => state.packages,
      assertReady: async () => {},
      riskApproval: async (_, published) => state.risk(published.head),
      askRiskApproval: async (_, published) => {
        state.riskAsked.push(published.head);
        return { kind: "asked" };
      },
      mergedOutsideLane: async () => {
        handMergeReads.push(id);
        const sha = state.handMerged.get(item.pull);
        if (sha === undefined || handMergeReads.length <= state.handMergeSeenAfter) return null;
        return {
          repositoryOwner: "acme",
          repositoryName: "app",
          pullNumber: item.pull,
          pullUrl: `https://github.com/acme/app/pull/${item.pull}`,
          mergeSha: sha,
        };
      },
      completed: () => completed.push(id),
    };
  }

  function say(kind: Line["kind"], body: string, key: string): void {
    if (keys.has(key)) return;
    keys.add(key);
    lines.push({ kind, body });
  }

  /** One lane turn, with the harness's payload for the task or the merge job's own. */
  async function pass(id: string, jobPayload?: Record<string, unknown>): Promise<MergeStep> {
    jobId += 1;
    const payload = jobPayload ?? payloads.get(id)!;
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

  /** The queue conflict sweep for main's commit `main`, as its job runs it. */
  function sweep(main: string | null): Promise<string[]> {
    return returnQueuedConflicts(
      db,
      { repository: "acme/app", main },
      {
        ask,
        now: () => clock.now(),
        session: (current) => current.sessionKey,
        voice: {
          thought: (_, body, key) => say("thought", body, key),
          flush: async () => {},
        },
        readPull: (_, prNumber) =>
          readPullMergeable({
            client,
            owner: "acme",
            repo: "app",
            prNumber,
            tokenProvider: { mode: "app", tokenFor: async () => "ghs_test" },
            sleep: async () => {},
          }),
      },
    );
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
    completed,
    published: publishedIds,
    addItem,
    requeue,
    closeout,
    remoteHead,
    moveMain,
    pass,
    sweep,
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
