import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Database } from "bun:sqlite";
import { cloneRunner } from "./helpers";
import { candidateRef, mirrorPath, type RunAgentOptions, type RunAgentResult } from "../src/acp";
import type { FakeScript } from "../src/acp/testing/script";
import {
  getRun,
  getWorkItem,
  listJobs,
  listWorkItems,
  recordItemCandidate,
  type Db,
  type Job,
  type JobLoop,
} from "../src/db";
import type { Orchestrator } from "../src/loop";
import {
  INSTALLATION_PERMISSIONS,
  fakeMergeReadiness,
  fakeRequiredChecks,
  type createFakeGitHub,
  type GitHubClient,
  type GitHubResponse,
} from "../src/github";

const exec = promisify(execFile);

export const CLOSEOUT_POLICY = `specVersion: "0.1"
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

const SEEDED_TEST = `import { expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

test("seeded check", () => {
  expect(existsSync("ok.txt")).toBe(true);
  if (existsSync("header.txt")) {
    expect(readFileSync("ok.txt", "utf8").includes("header")).toBe(true);
  }
});
`;

export async function repoLayout(tmpPrefix: string): Promise<{
  root: string;
  bare: string;
  pawsRoot: string;
  home: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), tmpPrefix));
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

export async function gitIdentity(dir: string): Promise<void> {
  await exec("git", ["-C", dir, "config", "user.email", "paws-test@example.com"]);
  await exec("git", ["-C", dir, "config", "user.name", "Paws Test"]);
  await exec("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
}

export function stateOf(db: Database, identifier: string): string | null {
  const row = db
    .query<{ state: string }, [string]>("SELECT state FROM work_item WHERE linear_identifier = ?")
    .get(identifier);
  return row?.state ?? null;
}

export async function stateOfPg(db: Db, identifier: string): Promise<string | null> {
  const items = await listWorkItems(db);
  return items.find((item) => item.linearIdentifier === identifier)?.state ?? null;
}

const RESTART_REASONS = new Set(["findings", "ci", "review", "conflict"]);

async function pendingRestart(db: Db): Promise<boolean> {
  const jobs = (await listJobs(db))
    .filter((job) => job.queue === "run.resume" && job.status === "pending")
    .sort((a, b) => a.id - b.id);
  for (const job of jobs) {
    const payload = job.payload as { itemId?: string; reason?: string } | null;
    if (!payload?.itemId || !RESTART_REASONS.has(payload.reason ?? "")) continue;
    if ((await getWorkItem(db, payload.itemId))?.state === "queued") return true;
  }
  return false;
}

export async function tickWithRestartsPg(
  jobs: JobLoop,
  orchestrator: Orchestrator,
  db: Db,
): Promise<Job | null> {
  const first = await jobs.tick();
  for (let turn = 0; turn < 4; turn++) {
    if (!(await pendingRestart(db))) break;
    await orchestrator.reconcileExecution();
    await jobs.tick(["run.resume"]);
    if (first?.queue === "github.merge") await jobs.tick(["github.merge"]);
  }
  return first;
}

export function cloneRunnerPg(
  repository: { owner: string; repo: string },
  agent: (options: RunAgentOptions) => Promise<RunAgentResult>,
  db: Db,
) {
  const run = cloneRunner(repository, agent);
  return async (options: RunAgentOptions): Promise<RunAgentResult> => {
    const mirror = mirrorPath(options.pawsRoot, repository.owner, repository.repo);
    const ref = candidateRef(options.itemId);
    const sha = () =>
      Bun.spawnSync(["/usr/bin/git", "--git-dir", mirror, "rev-parse", "--verify", "-q", ref]);
    const held = sha().exitCode === 0;
    const result = await run(options);
    if (!held || options.role !== "implementer") return result;
    const item = await getWorkItem(db, (await getRun(db, options.runId))?.itemId ?? "");
    if (item)
      await recordItemCandidate(db, {
        itemId: item.id,
        sha: sha().stdout.toString().trim(),
        branch: item.branchName,
        recordedAt: Date.now(),
      });
    return result;
  };
}

export function emptyReview(): FakeScript {
  return {
    steps: [
      {
        type: "update",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "[]" },
        },
      },
      { type: "end", stopReason: "end_turn" },
    ],
  };
}

export function writeOk(worktree: string, content = "ok\n"): FakeScript["steps"][number] {
  return { type: "fs_write", path: path.join(worktree, "ok.txt"), content };
}

export function isMergeReadiness(req: { path: string; body?: unknown }): boolean {
  return (
    req.path === "/graphql" &&
    typeof (req.body as { variables?: { head?: unknown } } | undefined)?.variables?.head ===
      "string"
  );
}

export function githubClient(
  bare: string,
  github: ReturnType<typeof createFakeGitHub>,
  seen: string[] = [],
  repository = { owner: "pmdroid", repo: "paws-demo" },
): GitHubClient {
  const fullName = `${repository.owner}/${repository.repo}`;
  let n = 0;
  const mergeShas = new Map<number, string>();
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
        n += 1;
        await github.mintInstallationToken({
          installationId: "2",
          repository: fullName,
        });
        return {
          status: 201,
          body: {
            token: `ghs_e2e_${n}`,
            expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            repository_selection: "selected",
            repositories: [{ name: repository.repo, full_name: fullName }],
            permissions: { ...INSTALLATION_PERMISSIONS, metadata: "read" },
          },
        };
      }
      if (req.method === "POST" && req.path.endsWith("/labels")) {
        if (req.path.includes("/issues/")) return { status: 200, body: [{ name: "paws" }] };
        return { status: 201, body: { name: "paws" } };
      }
      if (req.method === "POST" && req.path.endsWith("/pulls")) {
        const body = req.body as { title: string; head: string; base: string; body: string };
        const opened = await github.open({
          repository: fullName,
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
      if (req.method === "GET" && /\/pulls\/\d+$/.test(req.path)) {
        const number = Number(req.path.split("/").at(-1));
        const pull = github.opened[number - 1];
        if (!pull) return { status: 404, body: {} };
        const sha = mergeShas.get(number);
        return {
          status: 200,
          body: {
            merged: sha !== undefined,
            merge_commit_sha: sha ?? null,
            html_url: `https://github.com/${fullName}/pull/${number}`,
            base: { ref: pull.base, repo: { full_name: pull.repository } },
          },
        };
      }
      if (req.method === "PUT" && req.path.endsWith("/merge")) {
        const body = req.body as { sha?: string; commit_message?: string };
        const number = Number(req.path.split("/").at(-2));
        await github.merge({
          repository: fullName,
          number,
          expectedHeadSha: body.sha ?? "",
        });
        const sha = await squashBranch(bare, body.sha ?? "", body);
        mergeShas.set(number, sha);
        return { status: 200, body: { sha, merged: true } };
      }
      return { status: 404, body: {} };
    },
  };
}

async function squashBranch(
  bare: string,
  expected: string,
  body: { commit_message?: string },
): Promise<string> {
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
    await exec("git", ["-C", tmp, "commit", "-m", body.commit_message ?? "squash"]);
    await exec("git", ["-C", tmp, "push", "origin", "HEAD:main"]);
    return (await exec("git", ["-C", tmp, "rev-parse", "HEAD"])).stdout.trim();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
