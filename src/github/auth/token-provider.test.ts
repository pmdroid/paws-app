import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "bun:test";
import {
  INSTALLATION_PERMISSIONS,
  createAppTokenProvider,
  fakeMergeReadiness,
  fakeRequiredChecks,
  inferGitHubRepository,
  openPullRequest,
  parseGitHubRemote,
  pushBranch,
  serialMerge,
  type GitExec,
  type GitHubClient,
  type GitHubTokenProvider,
} from "../index";

const exec = promisify(execFile);
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const PRIVATE_KEY = privateKey as string;

/** Hands out numbered tokens so a test can see one fresh token per operation. */
function countingProvider(): GitHubTokenProvider & { issued: string[] } {
  const issued: string[] = [];
  return {
    mode: "token",
    issued,
    async tokenFor() {
      const token = `ghs_fake_${issued.length + 1}`;
      issued.push(token);
      return token;
    },
  };
}

async function scratch(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "paws-token-provider-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("GitHub operation tokens", () => {
  test("the App provider mints one scoped installation token per push", async () => {
    const fake = await scratch();
    const seen: Array<{ path: string; body?: unknown }> = [];
    const client: GitHubClient = {
      async request(req) {
        seen.push({ path: req.path, body: req.body });
        if (req.path.endsWith("/access_tokens")) {
          return { status: 201, body: tokenBody("ghs_app_only") };
        }
        return { status: 404, body: {} };
      },
    };
    const provider = createAppTokenProvider({
      client,
      appId: "99",
      installationId: "7",
      privateKeyPem: PRIVATE_KEY,
      owner: "pmdroid",
      repo: "paws-demo",
    });
    expect(provider.mode).toBe("app");
    const gitExec: GitExec = async (args) => {
      if (args.includes("rev-parse")) return { stdout: `${"b".repeat(40)}\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const pushed = await pushBranch({
      tokenProvider: provider,
      worktree: fake.root,
      issue: "ENG-17",
      owner: "pmdroid",
      repo: "paws-demo",
      remoteUrl: "https://github.com/pmdroid/paws-demo.git",
      gitExec,
    });
    expect(pushed.branch).toBe("paws/ENG-17");
    expect(seen[0]?.path).toBe("/app/installations/7/access_tokens");
    expect(seen[0]?.body).toEqual({
      repositories: ["paws-demo"],
      permissions: INSTALLATION_PERMISSIONS,
    });
    await fake.cleanup();
  });

  test("an App pull request body starts with the issue reference", async () => {
    const seen: unknown[] = [];
    const client: GitHubClient = {
      async request(req) {
        seen.push(req.body);
        if (req.path.endsWith("/access_tokens")) {
          return { status: 201, body: tokenBody("ghs_pr") };
        }
        return {
          status: 201,
          body: { number: 3, html_url: "https://github.com/pmdroid/paws-demo/pull/3", body: "" },
        };
      },
    };
    const provider = createAppTokenProvider({
      client,
      appId: "99",
      installationId: "7",
      privateKeyPem: PRIVATE_KEY,
      owner: "pmdroid",
      repo: "paws-demo",
    });
    await openPullRequest({
      tokenProvider: provider,
      client,
      issue: "ENG-17",
      owner: "pmdroid",
      repo: "paws-demo",
      evidence: "Closeout: accepted",
    });
    const body = (seen[1] as { body: string }).body;
    expect(body.startsWith("Fixes ENG-17")).toBe(true);
  });

  test("merge asks for separate push, readiness, and merge tokens", async () => {
    const fake = await scratch();
    const provider = countingProvider();
    const head = "a".repeat(40);
    const base = "b".repeat(40);
    const tokens: string[] = [];
    const readinessTokens: string[] = [];
    const client: GitHubClient = {
      async request(req) {
        if (req.path.endsWith("/access_tokens")) throw new Error("app path");
        if (req.path.endsWith("/merge")) {
          expect(req.token).toBe("ghs_fake_3");
          return { status: 200, body: { merged: true, sha: "c".repeat(40) } };
        }
        readinessTokens.push(req.token);
        if (req.path === "/graphql") return { status: 200, body: fakeMergeReadiness(head) };
        return fakeRequiredChecks(req) ?? { status: 404, body: {} };
      },
    };
    const gitExec: GitExec = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("status")) return { stdout: "", stderr: "" };
      if (joined.includes("rev-parse") && joined.includes("refs/paws/upstream-main")) {
        return { stdout: `${base}\n`, stderr: "" };
      }
      if (joined.includes("rev-parse")) return { stdout: `${head}\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const result = await serialMerge({
      tokenProvider: provider,
      worktree: fake.root,
      issue: "ENG-17",
      owner: "pmdroid",
      repo: "paws-demo",
      prNumber: 4,
      appId: "1",
      installationId: "2",
      privateKeyPem: "unused",
      client,
      remoteUrl: "https://github.com/pmdroid/paws-demo.git",
      gitExec,
      onCredential: (_purpose, token) => tokens.push(token),
      reverify: async () => ({ accepted: true, outcome: "merged", summary: "Closeout: accepted" }),
    });
    expect(result.merged).toBe(true);
    expect(tokens).toEqual(["ghs_fake_1", "ghs_fake_3"]);
    // Readiness reads use their own token; the re-read just before the merge uses the merge token.
    expect(readinessTokens).toEqual([
      ...Array(3).fill("ghs_fake_2"),
      ...Array(3).fill("ghs_fake_3"),
    ]);
    expect(provider.issued).toHaveLength(3);
    await fake.cleanup();

    const dirty = await scratch();
    const dirtyProvider = countingProvider();
    const dirtyResult = await serialMerge({
      tokenProvider: dirtyProvider,
      worktree: dirty.root,
      issue: "ENG-17",
      owner: "pmdroid",
      repo: "paws-demo",
      prNumber: 4,
      appId: "1",
      installationId: "2",
      privateKeyPem: "unused",
      client,
      gitExec: async (args) => {
        if (args.includes("status")) return { stdout: " M dirty.txt\n", stderr: "" };
        throw new Error(`unexpected git ${args.join(" ")}`);
      },
      reverify: async () => ({ accepted: true, outcome: "merged", summary: "no" }),
    });
    expect(dirtyResult.outcome).toBe("dirty");
    expect(dirtyProvider.issued).toHaveLength(0);
    await dirty.cleanup();
  });

  test("infers owner and repo from PAWS_GITHUB_REPOSITORY or the git remote", async () => {
    expect(parseGitHubRemote("https://github.com/pmdroid/paws-demo.git")).toEqual({
      owner: "pmdroid",
      repo: "paws-demo",
    });
    expect(parseGitHubRemote("git@github.com:pmdroid/paws-demo.git")).toEqual({
      owner: "pmdroid",
      repo: "paws-demo",
    });
    expect(parseGitHubRemote("ssh://git@github.com/pmdroid/paws-demo.git")).toEqual({
      owner: "pmdroid",
      repo: "paws-demo",
    });
    expect(parseGitHubRemote("https://user:gho_secret@github.com/pmdroid/paws-demo")).toEqual({
      owner: "pmdroid",
      repo: "paws-demo",
    });
    expect(() =>
      parseGitHubRemote("https://user:gho_secret@example.com/pmdroid/paws-demo.git"),
    ).toThrow(/example\.com/);
    try {
      parseGitHubRemote("https://user:gho_secret@example.com/pmdroid/paws-demo.git");
    } catch (error) {
      expect(error instanceof Error ? error.message : "").not.toContain("gho_secret");
    }

    let gitCalled = false;
    const fromEnv = await inferGitHubRepository({
      cwd: "/tmp",
      env: { PAWS_GITHUB_REPOSITORY: "pmdroid/paws-demo" },
      gitExec: async () => {
        gitCalled = true;
        return { stdout: "git@github.com:other/repo.git\n", stderr: "" };
      },
    });
    expect(fromEnv).toEqual({ owner: "pmdroid", repo: "paws-demo" });
    expect(gitCalled).toBe(false);
    await expect(
      inferGitHubRepository({
        cwd: "/tmp",
        env: { PAWS_GITHUB_REPOSITORY: "not a repo" },
        gitExec: async () => ({ stdout: "", stderr: "" }),
      }),
    ).rejects.toThrow(/PAWS_GITHUB_REPOSITORY must be owner\/repo/);

    const root = await mkdtemp(path.join(tmpdir(), "paws-remote-"));
    try {
      await exec("git", ["init", "-b", "main", root]);
      await exec("git", [
        "-C",
        root,
        "remote",
        "add",
        "origin",
        "https://github.com/pmdroid/paws-demo.git",
      ]);
      const env = { ...process.env };
      delete env.PAWS_GITHUB_REPOSITORY;
      expect(await inferGitHubRepository({ cwd: root, env })).toEqual({
        owner: "pmdroid",
        repo: "paws-demo",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function tokenBody(token: string) {
  return {
    token,
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    repository_selection: "selected",
    repositories: [{ name: "paws-demo", full_name: "pmdroid/paws-demo" }],
    permissions: { ...INSTALLATION_PERMISSIONS, metadata: "read" },
  };
}
