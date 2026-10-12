import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "bun:test";
import {
  GhAuthError,
  INSTALLATION_PERMISSIONS,
  PAWS_EVIDENCE_MARKER,
  PAWS_LABEL,
  agentEnv,
  checkGhAuthStatus,
  checkGhPushPermission,
  createTokenProvider,
  fakeMergeReadiness,
  ghDoctorChecks,
  githubAuthMode,
  inferGitHubRepository,
  openPullRequest,
  parseGitHubRemote,
  readGhUserToken,
  pushBranch,
  serialMerge,
  type GitExec,
  type GitHubClient,
} from "../index";

const exec = promisify(execFile);
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const PRIVATE_KEY = privateKey as string;

const FAKE_GH = `#!/bin/sh
log="\${GH_FAKE_LOG:?}"
printf '%s\\n' "$*" >> "$log"
printf 'env GH_TOKEN=%s GITHUB_TOKEN=%s PAWS_GITHUB_TOKEN=%s\\n' "\${GH_TOKEN-}" "\${GITHUB_TOKEN-}" "\${PAWS_GITHUB_TOKEN-}" >> "$log"
cmd="$1"
sub="$2"
if [ "$cmd" = "auth" ] && [ "$sub" = "status" ]; then
  if [ "\${GH_FAKE_LOGGED_IN:-1}" = "0" ]; then
    echo "You are not logged into any GitHub hosts. Run gh auth login to authenticate." >&2
    exit 1
  fi
  echo "github.com"
  echo "  Logged in to github.com account paws-dev (keyring)"
  exit 0
fi
if [ "$cmd" = "auth" ] && [ "$sub" = "token" ]; then
  if [ "\${GH_FAKE_LOGGED_IN:-1}" = "0" ]; then
    echo "not logged in" >&2
    exit 1
  fi
  mode="\${GH_FAKE_TOKEN_MODE:-ok}"
  if [ "$mode" = "blank" ]; then
    printf '\\n'
    exit 0
  fi
  if [ "$mode" = "space" ]; then
    printf 'gho bad\\n'
    exit 0
  fi
  count="\${GH_FAKE_COUNT:?}"
  n=0
  if [ -f "$count" ]; then
    IFS= read -r n < "$count" || n=0
  fi
  if [ -z "$n" ]; then
    n=0
  fi
  n=$((n + 1))
  printf '%s\\n' "$n" > "$count"
  printf 'gho_fake_%s\\n' "$n"
  exit 0
fi
if [ "$cmd" = "api" ]; then
  if [ "\${GH_FAKE_LOGGED_IN:-1}" = "0" ]; then
    echo "HTTP 401: Requires authentication" >&2
    exit 1
  fi
  if [ "\${GH_FAKE_PUSH:-1}" = "0" ]; then
    printf '%s\\n' '{"permissions":{"admin":false,"push":false,"pull":true}}'
    exit 0
  fi
  printf '%s\\n' '{"permissions":{"admin":false,"push":true,"pull":true}}'
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 99
`;

type FakeGh = {
  root: string;
  bin: string;
  dir: string;
  log: string;
  count: string;
  cleanup: () => Promise<void>;
};

async function fakeGh(): Promise<FakeGh> {
  const root = await mkdtemp(path.join(tmpdir(), "paws-gh-cli-"));
  const dir = path.join(root, "bin");
  const empty = path.join(root, "empty-path");
  await mkdir(dir);
  await mkdir(empty);
  const bin = path.join(dir, "gh");
  await writeFile(bin, FAKE_GH, { mode: 0o755 });
  await chmod(bin, 0o755);
  return {
    root,
    bin,
    dir,
    log: path.join(root, "gh.log"),
    count: path.join(root, "count"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function ghEnv(fake: FakeGh, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: path.join(fake.root, "empty-path"),
    GH_FAKE_LOG: fake.log,
    GH_FAKE_COUNT: fake.count,
    GH_FAKE_LOGGED_IN: "1",
    GH_FAKE_PUSH: "1",
    ...extra,
  };
}

describe("gh auth token provider", () => {
  test("host identity uses the stored login without repository permissions or injected tokens", async () => {
    const fake = await fakeGh();
    try {
      const token = await readGhUserToken({
        owner: "owner",
        repo: "private",
        ghBin: fake.bin,
        env: ghEnv(fake, {
          GH_FAKE_PUSH: "0",
          GH_TOKEN: "synthetic-injected-gh-token",
          GITHUB_TOKEN: "synthetic-injected-github-token",
          PAWS_GITHUB_TOKEN: "synthetic-injected-paws-token",
        }),
      });
      expect(token).toBe("gho_fake_1");
      const log = await readFile(fake.log, "utf8");
      expect(log).toContain("auth status");
      expect(log).toContain("auth token");
      expect(log).not.toContain("api repos/");
      expect(log).not.toContain("synthetic-injected");
    } finally {
      await fake.cleanup();
    }
  });

  test("read access accepts a host login without push permission", async () => {
    const fake = await fakeGh();
    try {
      const provider = createTokenProvider(
        { auth: "gh" },
        {
          gh: {
            owner: "pmdroid",
            repo: "paws-demo",
            access: "read",
            ghBin: fake.bin,
            env: ghEnv(fake, { GH_FAKE_PUSH: "0" }),
          },
        },
      );
      expect(await provider.tokenFor("push")).toBe("gho_fake_1");
      const write = createTokenProvider(
        { auth: "gh" },
        {
          gh: {
            owner: "pmdroid",
            repo: "paws-demo",
            ghBin: fake.bin,
            env: ghEnv(fake, { GH_FAKE_PUSH: "0" }),
          },
        },
      );
      await expect(write.tokenFor("push")).rejects.toThrow("does not have push permission");
    } finally {
      await fake.cleanup();
    }
  });

  test("fetches a fresh token per push and keeps it out of the spawned agent env", async () => {
    const fake = await fakeGh();
    const beforeToken = process.env.PAWS_GITHUB_TOKEN;
    const provider = createTokenProvider(
      {},
      {
        gh: {
          owner: "pmdroid",
          repo: "paws-demo",
          ghBin: fake.bin,
          pathPrefix: fake.dir,
          env: ghEnv(fake, { GH_TOKEN: "gho_parent_must_not_be_reused" }),
        },
      },
    );
    expect(provider.mode).toBe("gh");
    const pushEnvs: NodeJS.ProcessEnv[] = [];
    const gitExec: GitExec = async (args, options) => {
      if (args.includes("push")) pushEnvs.push({ ...options.env });
      if (args.includes("rev-parse")) return { stdout: `${"a".repeat(40)}\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    };
    await pushBranch({
      tokenProvider: provider,
      worktree: fake.root,
      issue: "ENG-17",
      owner: "pmdroid",
      repo: "paws-demo",
      remoteUrl: "https://github.com/pmdroid/paws-demo.git",
      gitExec,
    });
    await pushBranch({
      tokenProvider: provider,
      worktree: fake.root,
      issue: "ENG-17",
      owner: "pmdroid",
      repo: "paws-demo",
      remoteUrl: "https://github.com/pmdroid/paws-demo.git",
      gitExec,
    });
    expect(pushEnvs.map((env) => env.PAWS_GITHUB_TOKEN)).toEqual(["gho_fake_1", "gho_fake_2"]);
    expect(pushEnvs[0]?.GH_TOKEN).toBeUndefined();
    expect(pushEnvs[0]?.GITHUB_TOKEN).toBeUndefined();
    expect(pushEnvs[1]?.GITHUB_TOKEN).toBeUndefined();
    const log = await readFile(fake.log, "utf8");
    expect(log.split("\n").filter((line) => line === "auth token")).toHaveLength(2);
    expect(log).not.toContain("gho_fake_");
    expect(log).not.toContain("gho_parent_must_not_be_reused");
    expect(JSON.stringify(provider)).not.toContain("gho_fake_");
    expect(process.env.PAWS_GITHUB_TOKEN).toBe(beforeToken);

    const fromGitEnv = await exec("/bin/sh", ["-c", "env"], {
      env: agentEnv(pushEnvs[0] ?? {}),
    });
    expect(fromGitEnv.stdout).not.toContain("gho_fake_1");
    expect(fromGitEnv.stdout).not.toContain("gho_fake_2");
    const leaked = agentEnv({
      PATH: "/usr/bin",
      HOME: "/tmp",
      GH_TOKEN: "gho_fake_1",
      GITHUB_TOKEN: "gho_fake_1",
      PAWS_GITHUB_TOKEN: "gho_fake_1",
      GH_ENTERPRISE_TOKEN: "gho_fake_1",
    });
    const spawned = await exec("/bin/sh", ["-c", "env"], { env: leaked });
    expect(spawned.stdout).not.toContain("gho_fake_1");
    expect(spawned.stdout).toContain("HOME=/tmp");
    await fake.cleanup();
  });

  test("finds a fake gh on pathPrefix and does not call a binary already on PATH", async () => {
    const fake = await fakeGh();
    const provider = createTokenProvider(
      { auth: "gh" },
      {
        gh: {
          owner: "pmdroid",
          repo: "paws-demo",
          pathPrefix: fake.dir,
          env: ghEnv(fake),
        },
      },
    );
    const token = await provider.tokenFor("push");
    expect(token).toBe("gho_fake_1");
    const log = await readFile(fake.log, "utf8");
    expect(log).toContain("auth status");
    expect(log).toContain("api repos/pmdroid/paws-demo");
    expect(log.split("\n").filter((line) => line === "auth token")).toHaveLength(1);
    await fake.cleanup();
  });

  test("missing login and missing push permission fail with a clear error", async () => {
    const loggedOut = await fakeGh();
    const loggedOutProvider = createTokenProvider(
      { auth: "gh" },
      {
        gh: {
          owner: "pmdroid",
          repo: "paws-demo",
          ghBin: loggedOut.bin,
          env: ghEnv(loggedOut, { GH_FAKE_LOGGED_IN: "0" }),
        },
      },
    );
    await expect(loggedOutProvider.tokenFor("push")).rejects.toThrow(GhAuthError);
    await expect(loggedOutProvider.tokenFor("pr")).rejects.toThrow(/not logged in/);
    const status = await checkGhAuthStatus({
      owner: "pmdroid",
      repo: "paws-demo",
      ghBin: loggedOut.bin,
      env: ghEnv(loggedOut, { GH_FAKE_LOGGED_IN: "0" }),
    });
    expect(status.ok).toBe(false);
    expect(status.message).toContain("not logged in");
    const loggedOutLog = await readFile(loggedOut.log, "utf8");
    expect(loggedOutLog).not.toContain("auth token");
    await loggedOut.cleanup();

    const noPush = await fakeGh();
    const noPushProvider = createTokenProvider(null, {
      gh: {
        owner: "pmdroid",
        repo: "paws-demo",
        ghBin: noPush.bin,
        env: ghEnv(noPush, { GH_FAKE_PUSH: "0" }),
      },
    });
    await expect(noPushProvider.tokenFor("merge")).rejects.toThrow(
      /does not have push permission on pmdroid\/paws-demo/,
    );
    const permission = await checkGhPushPermission({
      owner: "pmdroid",
      repo: "paws-demo",
      ghBin: noPush.bin,
      env: ghEnv(noPush, { GH_FAKE_PUSH: "0" }),
    });
    expect(permission.ok).toBe(false);
    expect(permission.message).toContain("push permission");
    const checks = await ghDoctorChecks({
      owner: "pmdroid",
      repo: "paws-demo",
      ghBin: noPush.bin,
      env: ghEnv(noPush, { GH_FAKE_PUSH: "1" }),
    });
    expect(checks.map((check) => check.ok)).toEqual([true, true]);
    await noPush.cleanup();

    const missing = await checkGhAuthStatus({
      owner: "pmdroid",
      repo: "paws-demo",
      ghBin: "/nonexistent/paws-gh",
      env: { PATH: "/nonexistent" },
    });
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain("gh is not on PATH");
    await expect(
      checkGhAuthStatus({ owner: "bad/name", repo: "paws-demo", ghBin: "/nonexistent/paws-gh" }),
    ).rejects.toThrow(/GitHub names/);
  });

  test("refuses a blank or whitespace token from gh auth token", async () => {
    const fake = await fakeGh();
    const blank = createTokenProvider(
      { auth: "gh" },
      {
        gh: {
          owner: "pmdroid",
          repo: "paws-demo",
          ghBin: fake.bin,
          env: ghEnv(fake, { GH_FAKE_TOKEN_MODE: "blank" }),
        },
      },
    );
    await expect(blank.tokenFor("push")).rejects.toThrow(/unusable token/);
    const spaced = createTokenProvider(
      { auth: "gh" },
      {
        gh: {
          owner: "pmdroid",
          repo: "paws-demo",
          ghBin: fake.bin,
          env: ghEnv(fake, { GH_FAKE_TOKEN_MODE: "space" }),
        },
      },
    );
    await expect(spaced.tokenFor("push")).rejects.toThrow(/unusable token/);
    await fake.cleanup();
  });

  test("github.auth app keeps the installation token path and does not call gh", async () => {
    const fake = await fakeGh();
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
    expect(githubAuthMode(undefined)).toBe("gh");
    expect(githubAuthMode({ auth: "" })).toBe("gh");
    expect(githubAuthMode({ auth: "app" })).toBe("app");
    expect(githubAuthMode({ auth: "oauth" })).toBe("oauth");
    expect(() => githubAuthMode({ auth: "pat" })).toThrow(
      /github\.auth must be "gh", "app", or "oauth"/,
    );
    const provider = createTokenProvider(
      { auth: "app" },
      {
        gh: {
          owner: "pmdroid",
          repo: "paws-demo",
          ghBin: fake.bin,
          env: ghEnv(fake),
        },
        app: {
          client,
          appId: "99",
          installationId: "7",
          privateKeyPem: PRIVATE_KEY,
          owner: "pmdroid",
          repo: "paws-demo",
        },
      },
    );
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
    await expect(readFile(fake.log, "utf8")).rejects.toThrow();
    await fake.cleanup();
  });

  test("a gh pull request is labeled paws and carries the evidence marker", async () => {
    const fake = await fakeGh();
    const provider = createTokenProvider(
      { auth: "gh" },
      {
        gh: {
          owner: "pmdroid",
          repo: "paws-demo",
          ghBin: fake.bin,
          env: ghEnv(fake),
        },
      },
    );
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const client: GitHubClient = {
      async request(req) {
        requests.push({ method: req.method, path: req.path, body: req.body });
        if (req.method === "POST" && req.path.endsWith("/pulls")) {
          return {
            status: 201,
            body: {
              number: 4,
              html_url: "https://github.com/pmdroid/paws-demo/pull/4",
              body: (req.body as { body: string }).body,
            },
          };
        }
        if (req.method === "POST" && req.path.endsWith("/labels")) return { status: 201, body: {} };
        if (req.method === "POST" && req.path.endsWith("/issues/4/labels")) {
          return { status: 200, body: [{ name: PAWS_LABEL }] };
        }
        return { status: 404, body: {} };
      },
    };
    const pull = await openPullRequest({
      tokenProvider: provider,
      client,
      issue: "ENG-17",
      owner: "pmdroid",
      repo: "paws-demo",
      title: "Export rows",
      evidence: "Closeout: accepted\n- typecheck (command): passed — exited 0",
    });
    expect(pull.number).toBe(4);
    const opened = requests.find((req) => req.path.endsWith("/pulls"));
    if (opened === undefined) throw new Error("pull request was not posted");
    const body = (opened.body as { body: string }).body;
    expect(body.split("\n")[0]).toBe("Fixes ENG-17");
    expect(body).toContain("typecheck");
    expect(body).toContain(PAWS_EVIDENCE_MARKER);
    expect(requests.some((req) => req.path.endsWith("/issues/4/labels"))).toBe(true);
    const label = requests.find((req) => req.path.endsWith("/issues/4/labels"));
    expect(label?.body).toEqual({ labels: [PAWS_LABEL] });
    expect(requests.some((req) => req.path.endsWith("/access_tokens"))).toBe(false);
    const log = await readFile(fake.log, "utf8");
    expect(log.split("\n").filter((line) => line === "auth token")).toHaveLength(1);
    await fake.cleanup();
  });

  test("an app pull request does not add the developer marker", async () => {
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
    const provider = createTokenProvider(
      { auth: "app" },
      {
        app: {
          client,
          appId: "99",
          installationId: "7",
          privateKeyPem: PRIVATE_KEY,
          owner: "pmdroid",
          repo: "paws-demo",
        },
      },
    );
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
    expect(body).not.toContain(PAWS_EVIDENCE_MARKER);
  });

  test("merge asks gh for separate push, readiness, and merge tokens", async () => {
    const fake = await fakeGh();
    const provider = createTokenProvider(
      { auth: "gh" },
      {
        gh: {
          owner: "pmdroid",
          repo: "paws-demo",
          ghBin: fake.bin,
          env: ghEnv(fake),
        },
      },
    );
    const head = "a".repeat(40);
    const base = "b".repeat(40);
    const tokens: string[] = [];
    const client: GitHubClient = {
      async request(req) {
        if (req.path.endsWith("/access_tokens")) throw new Error("app path");
        if (req.path === "/graphql") {
          expect(req.token).toBe("gho_fake_2");
          return { status: 200, body: fakeMergeReadiness(head) };
        }
        if (req.path.endsWith("/merge")) {
          expect(req.token).toBe("gho_fake_3");
          return { status: 200, body: { merged: true, sha: "c".repeat(40) } };
        }
        return { status: 404, body: {} };
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
    expect(tokens).toEqual(["gho_fake_1", "gho_fake_3"]);
    const log = await readFile(fake.log, "utf8");
    expect(log.split("\n").filter((line) => line === "auth token")).toHaveLength(3);
    await fake.cleanup();

    const dirty = await fakeGh();
    const dirtyProvider = createTokenProvider(
      { auth: "gh" },
      {
        gh: {
          owner: "pmdroid",
          repo: "paws-demo",
          ghBin: dirty.bin,
          env: ghEnv(dirty),
        },
      },
    );
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
    await expect(readFile(dirty.log, "utf8")).rejects.toThrow();
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
