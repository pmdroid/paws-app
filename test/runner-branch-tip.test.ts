import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/acp";
import { fastForwardToBranchTip } from "../src/runner-backend";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const remoteUrl = "https://github.com/fixture/repository.git";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "paws-branch-tip-"));
  roots.push(root);
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const run = (args: string[]) => git(args, { env });
  const publisher = join(root, "publisher");
  const remote = join(root, "remote.git");
  const worktree = join(root, "task");
  await run(["init", "-b", "main", publisher]);
  writeFileSync(join(publisher, "result.txt"), "base");
  await run(["-C", publisher, "add", "."]);
  await run(["-C", publisher, "commit", "-m", "Base"]);
  await run(["clone", "--quiet", "--bare", publisher, remote]);
  await run(["-C", publisher, "push", "--quiet", remote, "HEAD:refs/heads/paws/task"]);
  await run(["clone", "--quiet", "--no-hardlinks", remote, worktree]);
  const head = async () => (await run(["-C", worktree, "rev-parse", "HEAD"])).trim();
  const commit = async (text: string) => {
    writeFileSync(join(publisher, "result.txt"), text);
    await run(["-C", publisher, "commit", "-qam", text]);
    return (await run(["-C", publisher, "rev-parse", "HEAD"])).trim();
  };
  const push = (ref: string) =>
    run(["-C", publisher, "push", "--quiet", "--force", remote, `HEAD:refs/heads/${ref}`]);
  const networkGit = async (args: string[]) => {
    const local = args.map((arg) => (arg === remoteUrl ? remote : arg));
    return run(local);
  };
  return { worktree, head, commit, push, run, publisher, networkGit };
}

function input(worktree: string, networkGit: (args: string[]) => Promise<string>) {
  return {
    worktree,
    branch: "paws/task",
    remoteUrl,
    networkGit,
    signal: new AbortController().signal,
  };
}

test("a run starts from the branch tip when an earlier run pushed commits after its checkout", async () => {
  const f = await fixture();
  const pushed = await f.commit("pushed by an earlier run");
  await f.push("paws/task");

  expect(await fastForwardToBranchTip(input(f.worktree, f.networkGit))).toBe(pushed);
  expect(await f.head()).toBe(pushed);
});

test("a branch tip that rewrote the checkout's history leaves the checkout alone", async () => {
  const f = await fixture();
  const before = await f.head();
  await f.run(["-C", f.publisher, "checkout", "--quiet", "--orphan", "rewritten"]);
  await f.commit("rewritten");
  await f.push("paws/task");

  expect(await fastForwardToBranchTip(input(f.worktree, f.networkGit))).toBeNull();
  expect(await f.head()).toBe(before);
});

test("a branch that is not on GitHub yet leaves the checkout alone", async () => {
  const f = await fixture();
  const before = await f.head();

  expect(
    await fastForwardToBranchTip({ ...input(f.worktree, f.networkGit), branch: "paws/missing" }),
  ).toBeNull();
  expect(await f.head()).toBe(before);
});

test("a checkout already at the branch tip stays where it is", async () => {
  const f = await fixture();
  const before = await f.head();

  expect(await fastForwardToBranchTip(input(f.worktree, f.networkGit))).toBeNull();
  expect(await f.head()).toBe(before);
});

async function localCommit(f: Awaited<ReturnType<typeof fixture>>, text: string) {
  writeFileSync(join(f.worktree, "result.txt"), text);
  await f.run(["-C", f.worktree, "commit", "-qam", text]);
  return (await f.run(["-C", f.worktree, "rev-parse", "HEAD"])).trim();
}

async function rebasedUpstream(f: Awaited<ReturnType<typeof fixture>>, text: string) {
  writeFileSync(join(f.publisher, "other.txt"), "main moved");
  await f.run(["-C", f.publisher, "add", "."]);
  await f.run(["-C", f.publisher, "commit", "-qm", "main moved"]);
  return f.commit(text);
}

test("a branch tip that rebased the checkout's commits onto a newer main is adopted", async () => {
  const f = await fixture();
  await localCommit(f, "the item's work");
  const rebased = await rebasedUpstream(f, "the item's work");
  await f.push("paws/task");

  expect(await fastForwardToBranchTip(input(f.worktree, f.networkGit))).toBe(rebased);
  expect(await f.head()).toBe(rebased);
});

test("a rebased branch tip is not adopted when the checkout has work it lacks", async () => {
  const f = await fixture();
  await localCommit(f, "the item's work");
  const unpushed = await localCommit(f, "work only this checkout has");
  await rebasedUpstream(f, "the item's work");
  await f.push("paws/task");

  expect(await fastForwardToBranchTip(input(f.worktree, f.networkGit))).toBeNull();
  expect(await f.head()).toBe(unpushed);
});
