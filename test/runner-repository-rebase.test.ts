import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitHubGit } from "../src/github";
import type { RunnerCommand, RunnerRepositoryCommand } from "../src/runner-protocol";
import { createRunnerRepositories } from "../src/runner-repositories";
import { openRunnerRuntime } from "../src/runner-runtime";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const env = {
  PATH: "/usr/bin:/bin",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Author",
  GIT_AUTHOR_EMAIL: "author@example.invalid",
  GIT_COMMITTER_NAME: "Author",
  GIT_COMMITTER_EMAIL: "author@example.invalid",
};
const bot = { appId: "99", login: "paws-test[bot]", id: 88 };
const branch = "paws/item-1";

function git(args: string[], cwd: string, stdin?: string) {
  const child = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...env, HOME: cwd },
    ...(stdin === undefined ? {} : { stdin: Buffer.from(stdin) }),
  });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  return child.stdout.toString().trim();
}

function fixture(options: { conflict?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "paws-repository-rebase-"));
  roots.push(root);
  const source = join(root, "source");
  const origin = join(root, "origin.git");
  const agentHome = join(root, "agent");
  mkdirSync(source);
  mkdirSync(agentHome);
  const commit = (file: string, content: string, message: string) => {
    writeFileSync(join(source, file), content);
    git(["add", "."], source);
    git(["commit", "-q", "-m", message], source);
    return git(["rev-parse", "HEAD"], source);
  };
  git(["init", "-q", "-b", "main"], source);
  commit("main.txt", "base\n", "base");
  const base = commit("shared.txt", "base\n", "shared");
  git(["checkout", "-q", "-b", branch], source);
  commit(options.conflict ? "main.txt" : "shared.txt", "branch one\n", "branch one");
  const head = commit("branch.txt", "branch two\n", "branch two");
  git(["checkout", "-q", "main"], source);
  const main = commit("main.txt", "main moved\n", "main moved");
  git(["clone", "-q", "--bare", source, origin], root);
  const command: RunnerRepositoryCommand = {
    id: "01J00000000000000000REBASE",
    type: "rebase",
    runnerId: "runner",
    workspaceId: "workspace",
    issuedAt: Date.now(),
    expiresAt: Date.now() + 600_000,
    itemId: "item",
    repository: {
      owner: "acme",
      repo: "widgets",
      remoteUrl: "https://github.com/acme/widgets.git",
    },
    branch,
    head,
    main,
    bot,
  };
  const calls: { operation: string; token: string; lease?: string }[] = [];
  const networkGit = async (input: Parameters<typeof runGitHubGit>[0]) => {
    calls.push({
      operation: input.operation,
      token: input.token,
      ...(input.lease ? { lease: input.lease } : {}),
    });
    if (input.operation === "clone") git(["clone", "-q", "--bare", origin, input.dest!], root);
    else await runGitHubGit({ ...input, remoteUrl: origin });
  };
  const cache = join(root, "cache");
  const repositories = createRunnerRepositories({
    root: cache,
    home: root,
    agentHome,
    credential: async () => {
      throw new Error("A rebase uses its own credential");
    },
    networkGit,
  });
  const credentials: string[] = [];
  return {
    root,
    source,
    origin,
    cache,
    agentHome,
    base,
    command,
    calls,
    credentials,
    networkGit,
    rebase: (input = command) =>
      repositories.rebase(input, async () => {
        credentials.push(input.id);
        return "synthetic-write-token";
      }),
    tip: () => git(["rev-parse", `refs/heads/${branch}`], origin),
    clean() {
      expect(readdirSync(cache).filter((name) => !name.endsWith(".git"))).toEqual([]);
      const mirror = join(
        cache,
        readdirSync(cache).find((name) => name.endsWith(".git"))!,
      );
      expect(git(["--git-dir", mirror, "worktree", "list", "--porcelain"], root)).toBe(
        `worktree ${mirror}\nbare`,
      );
      expect(readdirSync(agentHome)).toEqual([]);
    },
  };
}

function patchIds(cwd: string, range: string) {
  const patches = git(["log", "-p", "--reverse", range], cwd);
  return git(["patch-id", "--stable"], cwd, `${patches}\n`)
    .split("\n")
    .map((line) => line.split(" ")[0]);
}

test("a clean rebase pushes a head on main with the branch's own patches, under the lease", async () => {
  const f = fixture();
  const result = await f.rebase();
  if (result.outcome !== "rebased") throw new Error(JSON.stringify(result));
  expect(f.tip()).toBe(result.head);
  git(["merge-base", "--is-ancestor", f.command.main, result.head], f.origin);
  expect(patchIds(f.origin, `${result.head}~2..${result.head}`)).toEqual(
    patchIds(f.origin, `${f.base}..${f.command.head}`),
  );
  expect(git(["rev-list", "--count", `${f.command.main}..${result.head}`], f.origin)).toBe("2");
  expect(git(["log", "-1", "--format=%an <%ae>|%ce", result.head], f.origin)).toBe(
    "Author <author@example.invalid>|88+paws-test[bot]@users.noreply.github.com",
  );
  expect(f.credentials).toEqual([f.command.id]);
  expect(f.calls.map((call) => call.operation)).toEqual(["clone", "push"]);
  expect(f.calls.every((call) => call.token === "synthetic-write-token")).toBe(true);
  expect(f.calls.at(-1)!.lease).toBe(f.command.head);
  f.clean();
  const again = await f.rebase({ ...f.command, head: result.head });
  expect(again).toEqual({ outcome: "rebased", head: result.head });
  expect(f.calls.map((call) => call.operation).slice(2)).toEqual(["fetch", "push"]);
  f.clean();
});

test("a conflict returns the files, pushes nothing and leaves no worktree", async () => {
  const f = fixture({ conflict: true });
  expect(await f.rebase()).toEqual({ outcome: "conflict", files: ["main.txt"] });
  expect(f.tip()).toBe(f.command.head);
  expect(f.calls.map((call) => call.operation)).toEqual(["clone"]);
  f.clean();
});

test("a branch that moved fails the lease and keeps what is on GitHub", async () => {
  const f = fixture();
  git(["checkout", "-q", branch], f.source);
  writeFileSync(join(f.source, "late.txt"), "late\n");
  git(["add", "."], f.source);
  git(["commit", "-q", "-m", "late"], f.source);
  git(["push", "-q", f.origin, branch], f.source);
  const moved = f.tip();
  const result = await f.rebase();
  expect(result).toEqual({
    outcome: "failed",
    reason: `The branch ${branch} moved from ${f.command.head}.`,
  });
  expect(f.tip()).toBe(moved);
  f.clean();
});

test("a head or main GitHub does not have fails without a worktree", async () => {
  const f = fixture();
  const missing = "0".repeat(40);
  expect(await f.rebase({ ...f.command, main: missing })).toEqual({
    outcome: "failed",
    reason: `The main commit ${missing} is not on GitHub.`,
  });
  expect(f.tip()).toBe(f.command.head);
  f.clean();
});

test("a rebase refuses a repository cache under the agent's home", async () => {
  const f = fixture();
  const repositories = createRunnerRepositories({
    root: join(f.agentHome, "cache"),
    home: f.root,
    agentHome: f.agentHome,
    credential: async () => "unused",
    networkGit: f.networkGit,
  });
  await expect(repositories.rebase(f.command, async () => "unused")).rejects.toThrow(
    "under the agent's home",
  );
  expect(f.calls).toEqual([]);
});

test("the runtime runs a delivered rebase command with its grant, posts the result and acknowledges it", async () => {
  const f = fixture();
  const spool = {
    root: join(f.root, "spool"),
    runnerUid: process.getuid!(),
    agentGid: process.getgid!(),
  };
  const results = {
    root: join(f.root, "results"),
    agentUid: process.getuid!(),
    resultsGid: process.getgid!(),
  };
  for (const directory of [spool.root, results.root]) {
    mkdirSync(directory);
    chmodSync(directory, 0o750);
  }
  const paired = {
    phase: "paired" as const,
    runnerId: "runner",
    workspaceId: "workspace",
    fingerprint: "acme",
    expiresAt: Date.now() + 3_600_000,
  };
  let pending: RunnerCommand[] = [f.command];
  const requests: string[] = [];
  const posted: unknown[] = [];
  const runtime = await openRunnerRuntime({
    root: mkdirSync(join(f.root, "runtime"), { recursive: true, mode: 0o700 })!,
    spool,
    results,
    repositoryRoot: join(f.root, "repositories"),
    home: f.root,
    onError: () => {},
    networkGit: f.networkGit,
    broker: {
      async start() {
        throw new Error("A rebase starts no worker");
      },
      async stop() {},
      alive: () => false,
    },
    daemon: {
      status: () => paired,
      heartbeat: async () => ({ leases: [], fenced: [] }),
      pollCommands: async () => ({ commands: pending, rejected: [], deniedRepositories: [] }),
      pendingCommands: () => pending,
      async acknowledgeCommand(id) {
        requests.push(`ack ${id}`);
        pending = pending.filter((command) => command.id !== id);
      },
      async issueRunGrant() {
        throw new Error("A rebase takes no run grant");
      },
      sendEvent: async () => ({ duplicate: false }),
      answers: async () => ({ answers: [] }),
      postResult: async () => ({ duplicate: false }),
      async repositoryCredential() {
        throw new Error("A rebase takes no run credential");
      },
      renewCertificate: async () => paired,
      uploadArtifact: async () => ({ ok: true }),
      uploadTranscript: async (_runId, chunk) => ({ offset: chunk.offset, duplicate: false }),
      finishTranscript: async () => ({ uri: "transcript" }),
      async repositoryCommandGrant(id) {
        requests.push(`grant ${id}`);
        return { token: "g".repeat(43), expiresAt: Date.now() + 60_000 };
      },
      async repositoryCommandCredential(id, token) {
        requests.push(`credential ${id} ${token === "g".repeat(43)}`);
        return {
          token: "synthetic-write-token",
          expiresAt: Date.now() + 600_000,
          remoteUrl: f.command.repository.remoteUrl,
          branch,
        };
      },
      async postRepositoryCommandResult(id, result) {
        requests.push(`result ${id}`);
        posted.push(result);
        return { duplicate: false };
      },
    },
  });
  try {
    const deadline = Date.now() + 15_000;
    while (pending.length && Date.now() < deadline) {
      await runtime.tick().catch(() => {});
      await Bun.sleep(5);
    }
  } finally {
    await runtime.stop();
  }
  const id = f.command.id;
  expect(requests).toEqual([`grant ${id}`, `credential ${id} true`, `result ${id}`, `ack ${id}`]);
  expect(posted).toEqual([{ outcome: "rebased", head: f.tip() }]);
  git(["merge-base", "--is-ancestor", f.command.main, f.tip()], f.origin);
}, 30_000);
