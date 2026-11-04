import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunnerRepositories } from ".";
import type { RunnerRebaseCommand } from "../runner-protocol";

const env = {
  PATH: "/usr/bin:/bin",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Agent",
  GIT_AUTHOR_EMAIL: "agent@example.invalid",
  GIT_COMMITTER_NAME: "Agent",
  GIT_COMMITTER_EMAIL: "agent@example.invalid",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
  return stdout.trim();
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "paws-runner-rebase-"));
  roots.push(root);
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const agentWorktree = path.join(root, "agent-worktree");
  await git(root, "init", "-q", "--bare", "-b", "main", origin);
  await git(root, "clone", "-q", origin, seed);
  await writeFile(path.join(seed, "shared.txt"), "base\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-qm", "base");
  await git(seed, "push", "-q", "origin", "HEAD:main");
  await git(root, "clone", "-q", origin, agentWorktree);
  await git(agentWorktree, "checkout", "-qb", "paws/eng-1");
  await writeFile(path.join(agentWorktree, "feature.txt"), "feature\n");
  await git(agentWorktree, "add", ".");
  await git(agentWorktree, "commit", "-qm", "feature");
  await git(agentWorktree, "push", "-q", "origin", "HEAD:paws/eng-1");
  const head = await git(agentWorktree, "rev-parse", "HEAD");
  const moveMain = async (file: string, content: string) => {
    await git(seed, "pull", "-q", "--ff-only", "origin", "main");
    await writeFile(path.join(seed, file), content);
    await git(seed, "add", ".");
    await git(seed, "commit", "-qm", `main changes ${file}`);
    await git(seed, "push", "-q", "origin", "HEAD:main");
    return git(seed, "rev-parse", "HEAD");
  };
  const repositoryRoot = path.join(root, "repositories");
  const operations: string[] = [];
  const repositories = createRunnerRepositories({
    root: repositoryRoot,
    home: root,
    credential: async () => {
      throw new Error("A rebase passes its own credential");
    },
    networkGit: async (input) => {
      operations.push(`${input.operation}:${input.cwd}`);
      if (input.operation === "clone")
        await git(input.cwd, "clone", "-q", "--bare", origin, input.dest!);
      else if (input.operation === "fetch")
        await git(input.dest!, "fetch", "-q", origin, "+refs/heads/*:refs/heads/*");
      else {
        const [, target] = input.refspec!.split(":");
        await git(
          input.cwd,
          "push",
          "-q",
          `--force-with-lease=${target}:${input.lease}`,
          origin,
          input.refspec!,
        );
      }
    },
  });
  const command = (main: string): RunnerRebaseCommand => ({
    id: "rebase-1",
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    issuedAt: 1,
    expiresAt: 60_000,
    type: "rebase",
    itemId: "item-1",
    repository: "https://github.com/acme/app.git",
    branch: "paws/eng-1",
    head,
    main,
    committer: { name: "Paws", email: "1+paws[bot]@users.noreply.github.com" },
  });
  const access: string[] = [];
  const credential = async (kind: "read" | "write") => {
    access.push(kind);
    return `token-${kind}`;
  };
  return {
    root,
    origin,
    agentWorktree,
    head,
    moveMain,
    repositoryRoot,
    operations,
    repositories,
    command,
    access,
    credential,
  };
}

describe("runner rebase", () => {
  test("rebases the branch onto main in a temporary worktree and pushes it with a lease", async () => {
    const f = await fixture();
    const main = await f.moveMain("other.txt", "main\n");
    const result = await f.repositories.rebase(f.command(main), f.credential);
    expect(result.outcome).toBe("rebased");
    const pushed = await git(f.origin, "rev-parse", "refs/heads/paws/eng-1");
    expect(result).toEqual({ outcome: "rebased", head: pushed });
    expect(await git(f.origin, "rev-parse", `${pushed}^`)).toBe(main);
    expect(await git(f.origin, "log", "-1", "--format=%an|%cn", pushed)).toBe("Agent|Paws");
    expect(f.access).toEqual(["read", "write"]);
    expect(f.operations.every((operation) => !operation.includes(f.agentWorktree))).toBe(true);
    expect(await git(f.agentWorktree, "rev-parse", "HEAD")).toBe(f.head);
    expect(await git(f.agentWorktree, "status", "--porcelain")).toBe("");
    const left = await readdir(f.repositoryRoot);
    expect(left.filter((entry) => entry.startsWith("rebase-"))).toEqual([]);
    const mirror = path.join(
      f.repositoryRoot,
      left.find((entry) => entry.endsWith(".git"))!,
    );
    expect((await git(mirror, "worktree", "list", "--porcelain")).split("\n")[0]).toBe(
      `worktree ${mirror}`,
    );
    expect(
      await git(mirror, "for-each-ref", "--format=%(refname)", "refs/heads/paws-rebase-*"),
    ).toBe("");
  });

  test("a conflict returns the conflicting files and pushes nothing", async () => {
    const f = await fixture();
    const main = await f.moveMain("feature.txt", "main's version\n");
    const result = await f.repositories.rebase(f.command(main), f.credential);
    expect(result).toEqual({ outcome: "conflict", files: ["feature.txt"] });
    expect(await git(f.origin, "rev-parse", "refs/heads/paws/eng-1")).toBe(f.head);
    expect(f.access).toEqual(["read"]);
    expect((await readdir(f.repositoryRoot)).some((entry) => entry.startsWith("rebase-"))).toBe(
      false,
    );
  });

  test("a branch that moved since the accepted head refuses the push", async () => {
    const f = await fixture();
    const main = await f.moveMain("other.txt", "main\n");
    await writeFile(path.join(f.agentWorktree, "feature.txt"), "moved\n");
    await git(f.agentWorktree, "commit", "-qam", "moved");
    await git(f.agentWorktree, "push", "-q", "origin", "HEAD:paws/eng-1");
    const moved = await git(f.agentWorktree, "rev-parse", "HEAD");
    const result = await f.repositories.rebase(f.command(main), f.credential);
    expect(result.outcome).toBe("failed");
    expect(await git(f.origin, "rev-parse", "refs/heads/paws/eng-1")).toBe(moved);
  });
});
