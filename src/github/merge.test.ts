import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { branchForIssue, fixesLine } from "./branch";
import { fakeMergeReadiness } from "./fake";
import { serialMerge } from "./merge";
import { openPullRequest, publishAccepted, pushBranch } from "./pulls";
import {
  INSTALLATION_PERMISSIONS,
  type GitExec,
  type GitHubClient,
  type GitHubResponse,
} from "./types";

const exec = promisify(execFile);
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const PRIVATE_KEY = privateKey as string;

describe("pull requests and serial merge", () => {
  for (const scenario of ["failed CI", "unreadable gates", "closed PR", "moved PR head"]) {
    test(`does not merge with ${scenario} after Closeout accepts`, async () => {
      const repo = await oneClone();
      try {
        await commitFile(repo.work, "file.txt", "candidate\n");
        const client = mergingClient(repo.bare, []);
        let merges = 0;
        const guarded: GitHubClient = {
          async request(req) {
            if (req.path === "/graphql") {
              if (scenario === "unreadable gates") return { status: 403, body: {} };
              const { head } = (req.body as { variables: { head: string } }).variables;
              const body = fakeMergeReadiness(head);
              const repository = body.data.repository;
              if (scenario === "failed CI") repository.object.statusCheckRollup.state = "FAILURE";
              if (scenario === "closed PR") repository.pullRequest.state = "CLOSED";
              if (scenario === "moved PR head") repository.pullRequest.headRefOid = "b".repeat(40);
              return { status: 200, body };
            }
            if (req.path.endsWith("/merge")) merges += 1;
            return client.request(req);
          },
        };
        const result = await serialMerge({
          ...creds(guarded),
          worktree: repo.work,
          issue: "ENG-8",
          prNumber: 8,
          remoteUrl: repo.bare,
          reverify: async () => ({ accepted: true, outcome: "merged", summary: "accepted" }),
        });
        expect(result.merged).toBe(false);
        expect(merges).toBe(0);
        expect(result.outcome).toBe(scenario === "moved PR head" ? "sha_moved" : "blocked");
      } finally {
        await repo.cleanup();
      }
    });
  }

  test("branch names and the Fixes line keep the issue key", () => {
    expect(branchForIssue("ENG-123")).toBe("paws/ENG-123");
    expect(fixesLine("ENG-123")).toBe("Fixes ENG-123");
    expect(() => branchForIssue("ENG-123/../main")).toThrow();
  });

  test("push uses a one-shot helper and does not put the token on the command line", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const gitExec: GitExec = async (args, options) => {
      calls.push({ args, env: options.env });
      if (args.includes("rev-parse")) return { stdout: `${"a".repeat(40)}\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    };
    let minted = 0;
    const client = tokenClient(() => {
      minted += 1;
      return `ghs_push_${minted}`;
    });
    const result = await pushBranch({
      worktree: "/tmp/does-not-matter",
      issue: "ENG-123",
      owner: "pmdroid",
      repo: "paws-demo",
      appId: "1",
      installationId: "2",
      privateKeyPem: PRIVATE_KEY,
      client,
      remoteUrl: "https://github.com/pmdroid/paws-demo.git",
      gitExec,
    });
    expect(result.branch).toBe("paws/ENG-123");
    const push = calls.find((call) => call.args.includes("push"));
    expect(push).toBeDefined();
    const rendered = push?.args.join(" ") ?? "";
    expect(rendered).toContain("credential.helper=");
    expect(rendered).toContain("HEAD:refs/heads/paws/ENG-123");
    expect(rendered).not.toContain("ghs_push_1");
    expect(push?.env.PAWS_GITHUB_TOKEN).toBe("ghs_push_1");
    expect(push?.env.GITHUB_TOKEN).toBeUndefined();
    expect(push?.env.GH_TOKEN).toBeUndefined();
  });

  test("opens a pull request whose body starts with Fixes ENG-123", async () => {
    const bodies: unknown[] = [];
    const client: GitHubClient = {
      async request(req) {
        if (req.path.endsWith("/access_tokens")) {
          return { status: 201, body: tokenBody(`ghs_${bodies.length + 1}`) };
        }
        bodies.push(req.body);
        return {
          status: 201,
          body: {
            number: 4,
            html_url: "https://github.com/pmdroid/paws-demo/pull/4",
            body: (req.body as { body: string }).body,
          },
        };
      },
    };
    const pull = await openPullRequest({
      issue: "ENG-123",
      owner: "pmdroid",
      repo: "paws-demo",
      title: "Add CSV export",
      evidence: "Closeout: accepted\n- typecheck (command): passed — exited 0",
      appId: "1",
      installationId: "2",
      privateKeyPem: PRIVATE_KEY,
      client,
    });
    expect(pull.number).toBe(4);
    const body = (bodies[0] as { body: string; head: string }).body;
    expect(body.split("\n")[0]).toBe("Fixes ENG-123");
    expect(body).toContain("typecheck");
    expect((bodies[0] as { head: string }).head).toBe("paws/ENG-123");
  });

  test("does not open a pull request when Closeout did not accept", async () => {
    let calls = 0;
    const client: GitHubClient = {
      async request() {
        calls += 1;
        return { status: 500, body: {} };
      },
    };
    const result = await publishAccepted({
      accepted: false,
      evidence: "Closeout: exhausted",
      worktree: "/tmp/none",
      issue: "ENG-123",
      owner: "pmdroid",
      repo: "paws-demo",
      appId: "1",
      installationId: "2",
      privateKeyPem: PRIVATE_KEY,
      client,
    });
    expect(result.published).toBe(false);
    expect(calls).toBe(0);
  });

  test("merges two items in order, rebasing the second onto the new main", async () => {
    const repo = await twoClones();
    const tokens: string[] = [];
    const bases: string[] = [];
    const client = mergingClient(repo.bare, tokens);
    const lines = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`);
    await commitFile(
      repo.wtA,
      "file.txt",
      [...lines.slice(0, 0), "line-1-from-a", ...lines.slice(1)].join("\n") + "\n",
    );
    await pushBranch({
      ...creds(client),
      worktree: repo.wtA,
      issue: "ENG-1",
      remoteUrl: repo.bare,
    });
    const first = await serialMerge({
      ...creds(client),
      worktree: repo.wtA,
      issue: "ENG-1",
      prNumber: 1,
      remoteUrl: repo.bare,
      onCredential: (purpose, token) => tokens.push(`${purpose}:${token}`),
      reverify: async ({ base, head }) => {
        bases.push(base);
        const current = (await exec("git", ["-C", repo.wtA, "rev-parse", "HEAD"])).stdout.trim();
        expect(head).toBe(current);
        return { accepted: true, outcome: "merged" as const, summary: "Closeout: accepted" };
      },
    });
    expect(first.merged).toBe(true);
    expect(first.outcome).toBe("merged");

    const changedTail = [...lines];
    changedTail[19] = "line-20-from-b";
    await commitFile(repo.wtB, "file.txt", `${changedTail.join("\n")}\n`);
    await pushBranch({
      ...creds(client),
      worktree: repo.wtB,
      issue: "ENG-2",
      remoteUrl: repo.bare,
    });
    const seen: string[] = [];
    const second = await serialMerge({
      ...creds(client),
      worktree: repo.wtB,
      issue: "ENG-2",
      prNumber: 2,
      remoteUrl: repo.bare,
      reverify: async ({ base, head }) => {
        seen.push(base);
        const current = (await exec("git", ["-C", repo.wtB, "rev-parse", "HEAD"])).stdout.trim();
        expect(head).toBe(current);
        expect(base).not.toBe(bases[0]);
        return { accepted: true, outcome: "merged", summary: "Closeout: accepted" };
      },
    });
    expect(second.merged).toBe(true);
    const main = await showMain(repo.bare, "file.txt");
    expect(main.startsWith("line-1-from-a\n")).toBe(true);
    expect(main.endsWith("line-20-from-b\n")).toBe(true);
    const pushTokens = tokens.filter((entry) => entry.startsWith("push:"));
    const mergeTokens = tokens.filter((entry) => entry.startsWith("merge:"));
    expect(pushTokens.length).toBeGreaterThan(0);
    expect(mergeTokens.length).toBeGreaterThan(0);
    expect(new Set([...pushTokens, ...mergeTokens]).size).toBe(
      pushTokens.length + mergeTokens.length,
    );
    await repo.cleanup();
  });

  test("fails closed and re-verifies when HEAD changes after Closeout", async () => {
    const repo = await oneClone();
    await commitFile(repo.work, "file.txt", "one\n");
    const client = mergingClient(repo.bare, []);
    let checks = 0;
    let merges = 0;
    const wrapped: GitHubClient = {
      async request(req) {
        if (req.path.endsWith("/merge")) merges += 1;
        return client.request(req);
      },
    };
    const result = await serialMerge({
      ...creds(wrapped),
      worktree: repo.work,
      issue: "ENG-9",
      prNumber: 9,
      remoteUrl: repo.bare,
      reverify: async () => {
        checks += 1;
        if (checks === 1) {
          await exec("git", ["-C", repo.work, "commit", "--allow-empty", "-m", "moved"]);
        }
        return { accepted: true, outcome: "merged", summary: "ok" };
      },
    });
    expect(result.merged).toBe(true);
    expect(checks).toBe(2);
    expect(merges).toBe(1);
    await repo.cleanup();
  });

  test("re-verifies a moved main after waiting for CI before merging", async () => {
    const repo = await twoClones();
    try {
      await commitFile(repo.wtA, "file.txt", "candidate\n");
      const client = mergingClient(repo.bare, []);
      let pending = true;
      const heads: string[] = [];
      const result = await serialMerge({
        ...creds({
          async request(req) {
            if (req.path === "/graphql" && pending) {
              const { head } = (req.body as { variables: { head: string } }).variables;
              const body = fakeMergeReadiness(head);
              body.data.repository.object.statusCheckRollup.state = "PENDING";
              return { status: 200, body };
            }
            return client.request(req);
          },
        }),
        worktree: repo.wtA,
        issue: "ENG-8",
        prNumber: 8,
        remoteUrl: repo.bare,
        sleep: async () => {
          await commitFile(repo.wtB, "other.txt", "new main\n");
          await exec("git", ["-C", repo.wtB, "push", "origin", "HEAD:main"]);
          pending = false;
        },
        reverify: async ({ head }) => {
          heads.push(head);
          return { accepted: true, outcome: "merged", summary: "accepted" };
        },
      });
      expect(result.merged).toBe(true);
      expect(result.cycle).toBe(2);
      expect(heads.length).toBe(2);
      expect(heads[1]).not.toBe(heads[0]);
      expect(await showMain(repo.bare, "other.txt")).toBe("new main\n");
    } finally {
      await repo.cleanup();
    }
  });

  test("a merge 409 re-verifies and is not treated as success", async () => {
    const repo = await oneClone();
    await commitFile(repo.work, "file.txt", "one\n");
    let merges = 0;
    const client = mergingClient(repo.bare, [], () => {
      merges += 1;
      if (merges === 1) return { status: 409, body: { message: "sha mismatch" } };
      return null;
    });
    let checks = 0;
    const result = await serialMerge({
      ...creds(client),
      worktree: repo.work,
      issue: "ENG-8",
      prNumber: 8,
      remoteUrl: repo.bare,
      reverify: async () => {
        checks += 1;
        return { accepted: true, outcome: "merged", summary: "ok" };
      },
    });
    expect(result.merged).toBe(true);
    expect(merges).toBe(2);
    expect(checks).toBe(2);
    await repo.cleanup();
  });

  test("aborts a rebase conflict and does not merge", async () => {
    const repo = await oneClone();
    await commitFile(repo.work, "file.txt", "from-item\n");
    const other = await cloneOf(repo.bare);
    await commitFile(other, "file.txt", "from-main\n");
    await exec("git", ["-C", other, "push", "origin", "HEAD:main"]);
    let merges = 0;
    const client = mergingClient(repo.bare, [], () => {
      merges += 1;
      return { status: 200, body: { merged: true, sha: "c".repeat(40) } };
    });
    const result = await serialMerge({
      ...creds(client),
      worktree: repo.work,
      issue: "ENG-7",
      prNumber: 7,
      remoteUrl: repo.bare,
      reverify: async () => ({ accepted: true, outcome: "merged", summary: "should not run" }),
    });
    expect(result.merged).toBe(false);
    expect(result.outcome).toBe("conflict");
    expect(merges).toBe(0);
    const status = (await exec("git", ["-C", repo.work, "status"])).stdout;
    expect(status).not.toContain("rebase in progress");
    await repo.cleanup();
    await rm(other, { recursive: true, force: true });
  });

  test("refuses a dirty worktree before minting a token", async () => {
    const repo = await oneClone();
    await writeFile(path.join(repo.work, "dirty.txt"), "wip\n");
    let calls = 0;
    const client: GitHubClient = {
      async request() {
        calls += 1;
        return { status: 500, body: {} };
      },
    };
    const result = await serialMerge({
      ...creds(client),
      worktree: repo.work,
      issue: "ENG-6",
      prNumber: 6,
      remoteUrl: repo.bare,
      reverify: async () => ({ accepted: true, outcome: "merged", summary: "no" }),
    });
    expect(result.outcome).toBe("dirty");
    expect(calls).toBe(0);
    await repo.cleanup();
  });

  test("does not merge when Closeout rejects the rebased head", async () => {
    const repo = await oneClone();
    await commitFile(repo.work, "notes.txt", "change\n");
    let merges = 0;
    const client = mergingClient(repo.bare, [], () => {
      merges += 1;
      return { status: 200, body: { merged: true, sha: "c".repeat(40) } };
    });
    const result = await serialMerge({
      ...creds(client),
      worktree: repo.work,
      issue: "ENG-4",
      prNumber: 4,
      remoteUrl: repo.bare,
      reverify: async () => ({ accepted: false, outcome: "rejected", summary: "typecheck failed" }),
    });
    expect(result.merged).toBe(false);
    expect(result.outcome).toBe("rejected");
    expect(merges).toBe(0);
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

function tokenClient(next: () => string): GitHubClient {
  return {
    async request(req) {
      if (!req.path.endsWith("/access_tokens")) return { status: 404, body: {} };
      return { status: 201, body: tokenBody(next()) };
    },
  };
}

function mergingClient(
  bare: string,
  sink: string[],
  onMerge?: () => GitHubResponse | null,
): GitHubClient {
  let n = 0;
  return {
    async request(req) {
      if (req.path === "/graphql") {
        const { head } = (req.body as { variables: { head: string } }).variables;
        return { status: 200, body: fakeMergeReadiness(head) };
      }
      if (req.path.endsWith("/access_tokens")) {
        n += 1;
        const token = `ghs_merge_${n}`;
        sink.push(token);
        return { status: 201, body: tokenBody(token) };
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
    if (!match) throw new Error(`no pushed branch at ${body.sha}`);
    const ref = match.slice(body.sha!.length).trim();
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

async function twoClones(): Promise<{
  bare: string;
  wtA: string;
  wtB: string;
  cleanup: () => Promise<void>;
}> {
  const repo = await oneClone();
  const wtB = path.join(repo.root, "wtB");
  await exec("git", ["clone", repo.bare, wtB]);
  await gitIdentity(wtB);
  return { bare: repo.bare, wtA: repo.work, wtB, cleanup: repo.cleanup };
}

async function cloneOf(bare: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "paws-other-"));
  await exec("git", ["clone", bare, dir]);
  await gitIdentity(dir);
  return dir;
}

async function commitFile(dir: string, file: string, contents: string): Promise<void> {
  await writeFile(path.join(dir, file), contents);
  await exec("git", ["-C", dir, "add", file]);
  await exec("git", ["-C", dir, "commit", "-m", `edit ${file}`]);
}

async function showMain(bare: string, file: string): Promise<string> {
  const tmp = await mkdtemp(path.join(tmpdir(), "paws-show-"));
  try {
    await exec("git", ["clone", bare, tmp]);
    return await readFile(path.join(tmp, file), "utf8");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
