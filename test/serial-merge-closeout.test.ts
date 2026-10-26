import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "bun:test";
import { evaluateCandidate, type Evaluation } from "../src/closeout";
import {
  INSTALLATION_PERMISSIONS,
  fakeMergeReadiness,
  fakeRequiredChecks,
  rebaseOntoMain,
  squashPull,
  type GitHubClient,
  type GitHubResponse,
} from "../src/github";

const exec = promisify(execFile);
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const PRIVATE_KEY = privateKey;

/**
 * Host-level composition. `src/github` does not import `src/closeout`; the lane rebases, Closeout
 * evaluates the rebased head, and only then is that exact head squashed.
 */
describe("the merge lane runs Closeout on a rebased head before it merges", () => {
  test("native Closeout accepts the rebased head and the squash carries it", async () => {
    const repo = await oneClone();
    await commitFile(repo.work, "file.txt", "checked\n");
    const other = path.join(repo.root, "other");
    await exec("git", ["clone", repo.bare, other]);
    await gitIdentity(other);
    await commitFile(other, "other.txt", "main moved\n");
    await exec("git", ["-C", other, "push", "origin", "HEAD:main"]);
    const client = mergingClient(repo.bare);
    const lane = {
      ...creds(client),
      worktree: repo.work,
      issue: "ENG-5",
      prNumber: 5,
      remoteUrl: repo.bare,
    };
    let reviewed = 0;
    const reportDir = path.join(repo.root, "report");
    const rebased = await rebaseOntoMain(lane);
    if (!rebased.rebased) throw new Error(`rebase failed: ${rebased.result.message}`);
    const evaluation = await evaluateCandidate({
      worktree: repo.work,
      taskId: "ENG-5",
      base: rebased.base,
      head: rebased.head,
      candidate: { session: "impl", model: "claude", provider: "anthropic" },
      reviewer: {
        async review() {
          reviewed += 1;
          return { session: "codex", model: "codex", provider: "openai", findings: [] };
        },
      },
      home: repo.home,
      pawsHome: repo.pawsHome,
    });
    await mkdir(reportDir, { recursive: true });
    await writeFile(
      path.join(reportDir, "closeout-reverify.json"),
      `${JSON.stringify({ recordedAt: new Date().toISOString(), base: rebased.base, head: rebased.head, evaluation }, null, 2)}\n`,
    );
    expect(evaluation.outcome).toBe("accepted");
    const result = await squashPull(lane, rebased, evaluation.decision?.message ?? "accepted");
    expect(result).toMatchObject({ merged: true, head: rebased.head });
    expect(reviewed).toBe(0);
    const report = JSON.parse(
      await readFile(path.join(reportDir, "closeout-reverify.json"), "utf8"),
    ) as { evaluation: Evaluation };
    expect(report.evaluation.outcome).toBe("accepted");
    expect(report.evaluation.decision?.candidate.task).toBe("ENG-5");
    expect(report.evaluation.decision?.items).toEqual([
      expect.objectContaining({ id: "test", kind: "command", state: "passed" }),
    ]);
    await repo.cleanup();
  });
});

function creds(client: GitHubClient) {
  return {
    owner: "pmdroid",
    repo: "paws-demo",
    appId: "11",
    installationId: "22",
    privateKeyPem: PRIVATE_KEY,
    client,
  };
}

function tokenBody(token: string) {
  return {
    token,
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    repository_selection: "selected",
    repositories: [{ name: "paws-demo", full_name: "pmdroid/paws-demo" }],
    permissions: { ...INSTALLATION_PERMISSIONS, metadata: "read" },
  };
}

function mergingClient(bare: string, onMerge?: () => GitHubResponse | null): GitHubClient {
  let n = 0;
  return {
    async request(req) {
      if (req.path === "/graphql") {
        const { head } = (req.body as { variables: { head: string } }).variables;
        return { status: 200, body: fakeMergeReadiness(head) };
      }
      const required = fakeRequiredChecks(req);
      if (required) return required;
      if (req.path.endsWith("/access_tokens")) {
        n += 1;
        return { status: 201, body: tokenBody(`ghs_merge_${n}`) };
      }
      if (req.path.endsWith("/merge")) {
        const custom = onMerge?.();
        if (custom) return custom;
        const sha = await squashBranch(bare, req);
        return { status: 200, body: { sha, merged: true, message: "merged" } };
      }
      return { status: 404, body: {} };
    },
  };
}

async function squashBranch(bare: string, req: { body?: unknown }): Promise<string> {
  const body = req.body as { sha?: string; commit_message?: string };
  expect(body.commit_message?.split("\n")[0]).toMatch(/^Fixes ENG-/);
  expect(body.sha).toMatch(/^[0-9a-f]{40}$/);
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
    const match = listed.split("\n").find((line) => line.startsWith(`${body.sha} `));
    if (!match || body.sha === undefined) throw new Error(`no pushed branch at ${body.sha}`);
    const ref = match.slice(body.sha.length).trim();
    await exec("git", ["-C", tmp, "merge", "--squash", ref]);
    await exec("git", ["-C", tmp, "commit", "-m", body.commit_message ?? "squash"]);
    await exec("git", ["-C", tmp, "push", "origin", "HEAD:main"]);
    return (await exec("git", ["-C", tmp, "rev-parse", "HEAD"])).stdout.trim();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function gitIdentity(dir: string): Promise<void> {
  await exec("git", ["-C", dir, "config", "user.email", "paws-test@example.com"]);
  await exec("git", ["-C", dir, "config", "user.name", "Paws Test"]);
  await exec("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
}

async function oneClone(): Promise<{
  root: string;
  bare: string;
  work: string;
  home: string;
  pawsHome: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "paws-gh-"));
  const bare = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const home = path.join(root, "home");
  const pawsHome = path.join(root, "paws");
  await mkdir(home);
  await mkdir(pawsHome);
  await exec("git", ["init", "--bare", "-b", "main", bare]);
  await exec("git", ["clone", bare, work]);
  await gitIdentity(work);
  await mkdir(path.join(work, ".agents"), { recursive: true });
  await writeFile(
    path.join(work, ".agents", "closeout.yaml"),
    `specVersion: "0.1"
retry:
  maxFailedAttemptsPerItem: 3
  scope: task
items:
  - id: test
    kind: command
    gate: beforePR
    exec: ["bun", "-e", "process.exit(0)"]
    timeoutSeconds: 30
`,
  );
  await writeFile(
    path.join(work, "file.txt"),
    `${Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join("\n")}\n`,
  );
  await exec("git", ["-C", work, "add", "."]);
  await exec("git", ["-C", work, "commit", "-m", "init"]);
  await exec("git", ["-C", work, "push", "origin", "HEAD:main"]);
  return {
    root,
    bare,
    work,
    home,
    pawsHome,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function commitFile(dir: string, file: string, contents: string): Promise<void> {
  await writeFile(path.join(dir, file), contents);
  await exec("git", ["-C", dir, "add", file]);
  await exec("git", ["-C", dir, "commit", "-m", `edit ${file}`]);
}
