import { tickWithRestarts } from "./helpers";
import { workspaceAdmission } from "./fake-workspace";
import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { FakeScript } from "../src/acp/testing/script";
import { systemClock } from "../src/core";
import { JobLoop, OutboxDispatcher, getWorkItem, listJobs, migrate, openDatabase } from "../src/db";
import {
  INSTALLATION_PERMISSIONS,
  createFakeGitHub,
  fakeMergeReadiness,
  fakeRequiredChecks,
  type GitHubClient,
  type GitHubResponse,
} from "../src/github";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator, itemPathId, type AgentLaunch } from "../src/loop";

const exec = promisify(execFile);
const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;

test("a Linear delegation publishes and merges three GitHub pull requests with one plain reply and one fix", async () => {
  const seed = JSON.parse(
    await readFile(new URL("../examples/paws-demo/epic/epic.json", import.meta.url), "utf8"),
  ) as DemoSeed;
  const layout = await repoLayout();
  const linear = createFakeTracker([
    {
      linearIssueId: "parent",
      identifier: "DEMO-1",
      title: seed.parent.title,
      description: seed.parent.description,
      subIssues: seed.children.map((child, index) => ({
        linearIssueId: `child-${index + 2}`,
        identifier: `DEMO-${index + 2}`,
        title: child.title,
        description: child.title,
      })),
    },
  ]);
  linear.deps.set("child-3", [
    { blockerLinearIssueId: "child-2", blockedLinearIssueId: "child-3" },
  ]);
  linear.deps.set("child-4", [
    { blockerLinearIssueId: "child-3", blockedLinearIssueId: "child-4" },
  ]);
  const prompts: string[] = [];
  const github = createFakeGitHub();
  const apiPaths: string[] = [];
  const client = githubClient(layout.bare, github, apiPaths);
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  let scripts = 0;
  const launch: AgentLaunch = (input) => {
    if (input.purpose !== "prepare") prompts.push(input.prompt);
    scripts += 1;
    const scriptPath = path.join(layout.root, `gh-script-${scripts}.json`);
    writeFileSync(
      scriptPath,
      JSON.stringify({
        ...demoScript(input),
        model: input.role === "reviewer" ? "test-codex-model" : "test-claude-model",
      }),
    );
    return {
      command: process.execPath,
      args: [fakeAgent, "", scriptPath],
      env: process.env,
    };
  };
  const orchestrator = attachOrchestrator({
    db,
    admission: workspaceAdmission(db),
    jobs,
    outbox,
    pawsRoot: layout.pawsRoot,
    home: layout.home,
    tracker: linear,
    repositories: [{ owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare }],
    githubForRepository: () => ({
      appId: "",
      installationId: "",
      privateKeyPem: "",
      client,
      tokenProvider: { mode: "token", tokenFor: async () => "synthetic-delivery-token" },
    }),
    launch,
  });
  await orchestrator.onLinearEvent(created("parent"));
  let delivered = false;
  let whileAsking = "";
  let stop = false;
  const answerer = (async () => {
    for (;;) {
      if (stop) return;
      const question = linear.questions.find((asked) =>
        asked.body.includes("Include archived rows?"),
      );
      if (question && !delivered) {
        delivered = true;
        whileAsking = ["DEMO-2", "DEMO-3", "DEMO-4"]
          .map((identifier) => stateOf(db, identifier) ?? "missing")
          .join("/");
        await orchestrator.onLinearEvent(reply(question.sessionId, "yes"));
      }
      await Bun.sleep(20);
    }
  })();

  try {
    const appeared = Date.now() + 10_000;
    while (Date.now() < appeared && stateOf(db, "DEMO-2") === null) await Bun.sleep(20);
    expect(stateOf(db, "DEMO-2"), debug(layout, db)).not.toBeNull();
    const deadline = Date.now() + 90_000;
    let idle = 0;
    while (Date.now() < deadline && !delegationMerged(db)) {
      const job = await tickWithRestarts(jobs, orchestrator, db);
      if (job === null) {
        idle += 1;
        if (idle > 3) break;
        await Bun.sleep(20);
      } else {
        idle = 0;
      }
    }
    stop = true;
    await answerer;

    expect(whileAsking, debug(layout, db)).toBe("merged/merged/awaiting_input");
    expect(delegationMerged(db), debug(layout, db)).toBe(true);
    expect(
      ["DEMO-2", "DEMO-3", "DEMO-4"].map((id) => stateOf(db, id)),
      debug(layout, db),
    ).toEqual(["merged", "merged", "merged"]);
    expect(github.opened.map((pull) => pull.head)).toEqual(
      ["DEMO-2", "DEMO-3", "DEMO-4"].map(
        (identifier) =>
          db
            .query<{ branch: string }, [string]>(
              "SELECT branch_name AS branch FROM work_item WHERE linear_identifier=?",
            )
            .get(identifier)!.branch,
      ),
    );
    expect(github.opened.map((pull) => pull.body.split("\n")[0])).toEqual([
      "Fixes DEMO-2",
      "Fixes DEMO-3",
      "Fixes DEMO-4",
    ]);
    expect(github.opened[0]?.body).toContain("Fix attempts: 0");
    expect(prompts.some((prompt) => prompt.includes("P1") && prompt.includes("failOn"))).toBe(true);
    const history = await readFile(
      path.join(layout.pawsRoot, "runs", runDirectory(db, "DEMO-2"), "closeout-history.jsonl"),
      "utf8",
    );
    expect(history).toContain("failOn P1");
    expect(github.merged).toHaveLength(3);
    expect(linear.questions.some((asked) => asked.body.includes("Include archived rows?"))).toBe(
      true,
    );
    expect(linear.progress.some((update) => update.body.includes("Epic complete."))).toBe(false);
    expect(apiPaths.some((apiPath) => apiPath.endsWith("/access_tokens"))).toBe(false);
    expect(apiPaths.some((apiPath) => apiPath.includes("webhook"))).toBe(false);
    expect(github.minted).toHaveLength(0);
  } finally {
    stop = true;
    db.close();
    await layout.cleanup();
  }
}, 120_000);

const P1_FINDING = JSON.stringify([
  {
    severity: "P1",
    location: "src/export.ts",
    explanation: "export drops every row",
    evidence: "the seeded test fails until the fix lands",
  },
]);

type DemoSeed = {
  parent: { title: string; description: string };
  children: Array<{ slug: string; title: string; blockedBy: string[] }>;
};

function reviewText(worktree: string, p1: boolean): string {
  if (p1 && !existsSync(path.join(worktree, "fixed.txt"))) return P1_FINDING;
  return "[]";
}

function reviewScript(text: string): FakeScript {
  return {
    steps: [
      {
        type: "update",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      },
      { type: "end", stopReason: "end_turn" },
    ],
  };
}

function demoScript(input: {
  purpose: string;
  itemId: string;
  worktree: string;
  prompt: string;
}): FakeScript {
  if (input.purpose === "review") {
    return reviewScript(reviewText(input.worktree, /^DEMO-2(-|$)/.test(input.itemId)));
  }
  if (input.purpose === "fix") {
    return {
      steps: [
        {
          type: "fs_write",
          path: path.join(input.worktree, "fixed.txt"),
          content: "fixed\n",
        },
        {
          type: "fs_write",
          path: path.join(input.worktree, "ok.txt"),
          content: "ok\n",
        },
        { type: "end", stopReason: "end_turn" },
      ],
    };
  }
  if (/^DEMO-4(-|$)/.test(input.itemId)) {
    if (input.prompt.includes("Handoff from the previous session.")) {
      return {
        steps: [
          {
            type: "fs_write",
            path: path.join(input.worktree, "archived.txt"),
            content: "yes\n",
          },
          {
            type: "fs_write",
            path: path.join(input.worktree, "ok.txt"),
            content: "ok\n",
          },
          { type: "end", stopReason: "end_turn" },
        ],
      };
    }
    return {
      steps: [
        {
          type: "ask_team",
          question: "Include archived rows?",
          options: ["yes", "no"],
        },
        { type: "end", stopReason: "end_turn" },
      ],
    };
  }
  return {
    steps: [
      {
        type: "fs_write",
        path: path.join(input.worktree, "ok.txt"),
        content: "ok\n",
      },
      {
        type: "fs_write",
        path: path.join(input.worktree, `${input.itemId}.txt`),
        content: "done\n",
      },
      { type: "end", stopReason: "end_turn" },
    ],
  };
}

function reply(sessionId: string, body: string): AcceptedLinearEvent {
  return {
    dedupeKey: `prompted:${sessionId}:${body}`,
    deliveryId: null,
    source: "webhook",
    action: "prompted",
    sessionId,
    issueId: null,
    activityId: "reply-1",
    actorId: "octocat",
    body,
    signal: null,
    updatedAtMs: Date.now(),
    payload: "{}",
  };
}

function runDirectory(db: Database, identifier: string): string {
  const row = db
    .query<{ id: string }, [string]>("SELECT id FROM work_item WHERE linear_identifier = ?")
    .get(identifier)!;
  return itemPathId(getWorkItem(db, row.id)!);
}

function created(issueId: string): AcceptedLinearEvent {
  return {
    dedupeKey: `created:${issueId}`,
    deliveryId: null,
    source: "poll",
    action: "created",
    sessionId: issueId,
    issueId,
    activityId: null,
    body: null,
    signal: null,
    updatedAtMs: Date.now(),
    payload: "{}",
  };
}

function githubClient(
  bare: string,
  github: ReturnType<typeof createFakeGitHub>,
  seen: string[],
): GitHubClient {
  return {
    async request(req): Promise<GitHubResponse> {
      seen.push(req.path);
      if (req.path === "/graphql") {
        const { head } = (req.body as { variables: { head: string } }).variables;
        return { status: 200, body: fakeMergeReadiness(head) };
      }
      const required = fakeRequiredChecks(req);
      if (required) return required;
      if (req.path.endsWith("/access_tokens")) {
        await github.mintInstallationToken({
          installationId: "2",
          repository: "pmdroid/paws-demo",
        });
        return {
          status: 201,
          body: {
            token: "ghs_should_not_be_used",
            expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            permissions: INSTALLATION_PERMISSIONS,
          },
        };
      }
      if (req.method === "POST" && req.path.endsWith("/pulls")) {
        const body = req.body as { title: string; head: string; base: string; body: string };
        const opened = await github.open({
          repository: "pmdroid/paws-demo",
          title: body.title,
          head: body.head,
          base: body.base,
          body: body.body,
        });
        return {
          status: 201,
          body: { number: opened.number, html_url: opened.url, body: body.body },
        };
      }
      if (req.method === "PUT" && req.path.endsWith("/merge")) {
        const body = req.body as { sha?: string };
        const number = Number(req.path.split("/").at(-2));
        await github.merge({
          repository: "pmdroid/paws-demo",
          number,
          expectedHeadSha: body.sha ?? "",
        });
        const sha = await squashBranch(bare, body.sha ?? "");
        return { status: 200, body: { sha, merged: true } };
      }
      if (req.method === "POST" && req.path.endsWith("/labels")) {
        return { status: 201, body: { name: "paws" } };
      }
      return { status: 404, body: {} };
    },
  };
}

async function squashBranch(bare: string, expected: string): Promise<string> {
  const tmp = await mkdtemp(path.join(tmpdir(), "paws-squash-"));
  try {
    await exec("git", ["clone", bare, tmp]);
    await gitIdentity(tmp);
    const listed = (
      await exec("git", [
        "-C",
        tmp,
        "for-each-ref",
        "--format=%(objectname) %(refname)",
        "refs/remotes/origin/paws",
      ])
    ).stdout.trim();
    const match = listed.split("\n").find((line) => line.startsWith(`${expected} `));
    if (!match) throw new Error(`no pushed branch at ${expected}`);
    const ref = match.slice(expected.length).trim();
    await exec("git", ["-C", tmp, "merge", "--squash", ref]);
    await exec("git", ["-C", tmp, "commit", "-m", "squash"]);
    await exec("git", ["-C", tmp, "push", "origin", "HEAD:main"]);
    return (await exec("git", ["-C", tmp, "rev-parse", "HEAD"])).stdout.trim();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function repoLayout(): Promise<{
  root: string;
  bare: string;
  pawsRoot: string;
  home: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "paws-gh-e2e-"));
  const bare = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const pawsRoot = path.join(root, "paws");
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  await mkdir(pawsRoot, { recursive: true });
  await exec("git", ["init", "--bare", "-b", "main", bare]);
  await exec("git", ["clone", bare, seed]);
  await gitIdentity(seed);
  await seedCloseoutPolicy(seed);
  await exec("git", ["-C", seed, "add", "."]);
  await exec("git", ["-C", seed, "commit", "-m", "init"]);
  await exec("git", ["-C", seed, "push", "origin", "HEAD:main"]);
  return {
    root,
    bare,
    pawsRoot,
    home,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function gitIdentity(dir: string): Promise<void> {
  await exec("git", ["-C", dir, "config", "user.email", "paws-test@example.com"]);
  await exec("git", ["-C", dir, "config", "user.name", "Paws Test"]);
  await exec("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
}

const CLOSEOUT_POLICY = `specVersion: "0.1"
retry:
  maxFailedAttemptsPerItem: 3
  scope: task
items:
  - id: test
    kind: command
    gate: beforePR
    exec: ["bun", "test", "check.test.ts"]
    timeoutSeconds: 60
  - id: adversarial-review
    kind: review
    gate: beforePR
    skill: .agents/skills/adversarial-review/SKILL.md
    independence:
      differentSession: true
      differentModel: true
    failOn: P1
`;

const REVIEW_SKILL = `---
name: adversarial-review
description: Review the candidate. Report findings. Do not decide acceptance.
---

# Review

Report findings. An empty list means the change is fine.
`;

const SEEDED_TEST = `import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

test("seeded check", () => {
  expect(existsSync("ok.txt")).toBe(true);
  if (existsSync("header.txt")) {
    expect(readFileSync("ok.txt", "utf8").includes("header")).toBe(true);
  }
});
`;

async function seedCloseoutPolicy(seed: string): Promise<void> {
  await mkdir(path.join(seed, ".agents", "skills", "adversarial-review"), { recursive: true });
  await writeFile(path.join(seed, ".agents", "closeout.yaml"), CLOSEOUT_POLICY);
  await writeFile(
    path.join(seed, ".agents", "skills", "adversarial-review", "SKILL.md"),
    REVIEW_SKILL,
  );
  await writeFile(path.join(seed, "check.test.ts"), SEEDED_TEST);
  await writeFile(path.join(seed, "README.md"), "paws demo\n");
}

function stateOf(db: Database, identifier: string): string | null {
  const row = db
    .query<{ id: string }, [string]>("SELECT id FROM work_item WHERE linear_identifier = ?")
    .get(identifier);
  if (!row) return null;
  return getWorkItem(db, row.id)?.state ?? null;
}

function delegationMerged(db: Database): boolean {
  const items = db.query<{ state: string }, []>("SELECT state FROM work_item").all();
  return items.length > 0 && items.every((item) => item.state === "merged");
}

function debug(layout: { pawsRoot: string }, db: Database): string {
  try {
    const jobs = listJobs(db).map((job) => `${job.queue}:${job.status}:${job.lastError ?? ""}`);
    const items = db
      .query<{ linear_identifier: string; state: string }, []>(
        "SELECT linear_identifier, state FROM work_item ORDER BY position",
      )
      .all();
    return JSON.stringify({ paws: layout.pawsRoot, items, jobs });
  } catch {
    return "db closed";
  }
}
