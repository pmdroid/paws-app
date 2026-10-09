import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "bun:test";
import { evaluateCandidate, writeFakeCloseout, type Evaluation } from "../src/closeout";
import {
  INSTALLATION_PERMISSIONS,
  serialMerge,
  type GitHubClient,
  type GitHubResponse,
  type SerialMergeResult,
} from "../src/github";

const exec = promisify(execFile);
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const PRIVATE_KEY = privateKey;

/**
 * Host-level composition. `src/github` does not import `src/closeout`;
 * the reverify callback is the seam between them.
 */
describe("serial merge re-runs closeout", () => {
  test("re-runs the pinned closeout CLI on the rebased head", async () => {
    const repo = await oneClone();
    await commitFile(repo.work, "file.txt", "checked\n");
    const fake = await writeFakeCloseout(repo.root, {
      version: "0.1.0",
      steps: [
        {
          exit: 0,
          decision: {
            specVersion: "0.1",
            decision: "accepted",
            gate: "beforePR",
            base: "a".repeat(40),
            head: "b".repeat(40),
            candidate: { session: "impl", model: "claude", provider: "anthropic" },
            policy: { path: null, digest: null, absent: true },
            items: [],
            warnings: [],
            message: "no closeout policy",
          },
        },
      ],
    });
    const client = mergingClient(repo.bare);
    let reviewed = 0;
    const reportDir = path.join(repo.root, "report");
    const result = await serialMerge({
      ...creds(client),
      worktree: repo.work,
      issue: "ENG-5",
      prNumber: 5,
      remoteUrl: repo.bare,
      reverify: async ({ worktree, base, head }) => {
        const evaluation = await evaluateCandidate({
          worktree,
          taskId: "ENG-5",
          base,
          head,
          candidate: { session: "impl", model: "claude", provider: "anthropic" },
          reviewer: {
            async review() {
              reviewed += 1;
              return { session: "codex", model: "gpt-5-codex", provider: "openai", findings: [] };
            },
          },
          closeoutBin: fake.bin,
        });
        await mkdir(reportDir, { recursive: true });
        await writeFile(
          path.join(reportDir, "closeout-reverify.json"),
          `${JSON.stringify({ recordedAt: new Date().toISOString(), base, head, evaluation }, null, 2)}\n`,
        );
        const summary = evaluation.error ?? evaluation.decision?.message ?? evaluation.outcome;
        return {
          accepted: evaluation.outcome === "accepted",
          outcome: reverifyOutcome(evaluation.outcome),
          summary,
        };
      },
    });
    expect(result.merged).toBe(true);
    expect(reviewed).toBe(0);
    const calls = (await fake.invocations()).filter((call) => call.argv[0] === "run");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toContain("--task");
    expect(calls[0]?.argv).toContain("ENG-5");
    expect(calls[0]?.argv).toContain("--json");
    const report = await readFile(path.join(reportDir, "closeout-reverify.json"), "utf8");
    expect(report).toContain("accepted");
    await repo.cleanup();
  });
});

function reverifyOutcome(outcome: Evaluation["outcome"]): SerialMergeResult["outcome"] {
  switch (outcome) {
    case "accepted":
      return "merged";
    case "rejected":
      return "rejected";
    case "exhausted":
      return "exhausted";
    case "blocked":
      return "blocked";
    case "invalid":
      return "invalid";
  }
}

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
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "paws-gh-"));
  const bare = path.join(root, "origin.git");
  const work = path.join(root, "work");
  await exec("git", ["init", "--bare", "-b", "main", bare]);
  await exec("git", ["clone", bare, work]);
  await gitIdentity(work);
  await writeFile(
    path.join(work, "file.txt"),
    `${Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join("\n")}\n`,
  );
  await exec("git", ["-C", work, "add", "file.txt"]);
  await exec("git", ["-C", work, "commit", "-m", "init"]);
  await exec("git", ["-C", work, "push", "origin", "HEAD:main"]);
  return { root, bare, work, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function commitFile(dir: string, file: string, contents: string): Promise<void> {
  await writeFile(path.join(dir, file), contents);
  await exec("git", ["-C", dir, "add", file]);
  await exec("git", ["-C", dir, "commit", "-m", `edit ${file}`]);
}
