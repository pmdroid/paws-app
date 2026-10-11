import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";
import { commitCheckpoint, commitCheckpointSync, restartFromFreshMain } from "./checkpoint";
import { git } from "./git";
import * as gitCommands from "./git";
import { createWorktree, ensureBareMirror } from "./worktree";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("shutdown commits dirty files onto the item branch", async () => {
  const layout = await itemWorktree("ENG-21");
  await writeFile(join(layout.worktree.path, "notes.txt"), "dirty\n");

  const checkpoint = commitCheckpointSync(layout.worktree.path);
  expect(checkpoint.committed).toBe(true);
  expect(checkpoint.sha).toBe(
    (await git(["-C", layout.worktree.path, "rev-parse", "HEAD"])).trim(),
  );
  expect((await git(["-C", layout.worktree.path, "log", "-1", "--format=%s"])).trim()).toBe(
    "wip: shutdown",
  );
  expect((await git(["-C", layout.worktree.path, "branch", "--show-current"])).trim()).toBe(
    "paws/eng-21",
  );
  expect(commitCheckpointSync(layout.worktree.path).committed).toBe(false);
  expect(commitCheckpointSync(join(layout.root, "missing")).committed).toBe(false);
}, 20_000);

for (const phase of ["add", "commit"] as const) {
  test(`abort during checkpoint ${phase} preserves the branch, staged entries and dirty files`, async () => {
    const layout = await itemWorktree("ENG-21");
    const tree = layout.worktree.path;
    await writeFile(join(tree, "README.md"), "staged\n");
    await git(["-C", tree, "add", "README.md"]);
    await writeFile(join(tree, "README.md"), "unstaged\n");
    await writeFile(join(tree, "partial.txt"), "partial\n");
    const index = (
      await git(["-C", tree, "rev-parse", "--path-format=absolute", "--git-path", "index"])
    ).trim();
    const beforeIndex = await readFile(index);
    const beforeHead = (await git(["-C", tree, "rev-parse", "HEAD"])).trim();
    const controller = new AbortController();
    const originalGit = gitCommands.git;
    let reached = false;
    const calls = spyOn(gitCommands, "git").mockImplementation(async (args, options) => {
      const result = await originalGit(args, options);
      if (args.includes(phase) || (phase === "commit" && args.includes("commit-tree"))) {
        reached = true;
        controller.abort();
      }
      return result;
    });
    try {
      const checkpoint = await commitCheckpoint(tree, "wip: interrupted", controller.signal);
      expect(reached).toBe(true);
      expect(checkpoint.committed).toBe(false);
      expect((await originalGit(["-C", tree, "rev-parse", "HEAD"])).trim()).toBe(beforeHead);
      expect(await readFile(index)).toEqual(beforeIndex);
      expect(await readFile(join(tree, "README.md"), "utf8")).toBe("unstaged\n");
      expect(await readFile(join(tree, "partial.txt"), "utf8")).toBe("partial\n");
    } finally {
      calls.mockRestore();
    }
  });
}

test("a long sleep checks out fresh main and keeps the WIP branch", async () => {
  const layout = await itemWorktree("ENG-21");
  await writeFile(join(layout.worktree.path, "notes.txt"), "wip\n");

  const checkout = restartFromFreshMain({
    pawsRoot: layout.pawsRoot,
    owner: "acme",
    repo: "demo",
    itemId: "ENG-21",
    wipBranch: "paws/eng-21",
  });

  expect(checkout.restarted).toBe(true);
  expect(checkout.wipBranch).toBe("paws/eng-21");
  expect(checkout.startRef).toBe("origin/main");
  expect(checkout.branch).toBe("paws/eng-21-fresh");
  const head = (await git(["-C", checkout.worktreePath, "rev-parse", "HEAD"])).trim();
  const main = (await git(["--git-dir", layout.mirror.path, "rev-parse", "origin/main"])).trim();
  expect(head).toBe(main);
  expect((await git(["-C", checkout.worktreePath, "branch", "--show-current"])).trim()).toBe(
    "paws/eng-21-fresh",
  );
  expect(await readFile(join(checkout.worktreePath, "README.md"), "utf8")).toBe("hello\n");
  await expect(readFile(join(checkout.worktreePath, "notes.txt"), "utf8")).rejects.toThrow();
  expect(
    (
      await git(["--git-dir", layout.mirror.path, "log", "-1", "--format=%s", "paws/eng-21"])
    ).trim(),
  ).toBe("wip: paused");
  expect(await git(["--git-dir", layout.mirror.path, "show", "paws/eng-21:notes.txt"])).toBe(
    "wip\n",
  );

  const again = await createWorktree({
    owner: "acme",
    repo: "demo",
    itemId: "ENG-21",
    pawsRoot: layout.pawsRoot,
  });
  expect(again.path).toBe(checkout.worktreePath);
  expect((await git(["-C", again.path, "rev-parse", "HEAD"])).trim()).toBe(main);
}, 20_000);

async function itemWorktree(itemId: string) {
  const root = await mkdtemp(join(tmpdir(), "paws-ckpt-"));
  roots.push(root);
  const source = join(root, "checkout");
  const pawsRoot = join(root, "home");
  await initRepo(source);
  const mirror = await ensureBareMirror({
    remoteUrl: source,
    owner: "acme",
    repo: "demo",
    pawsRoot,
  });
  const worktree = await createWorktree({ owner: "acme", repo: "demo", itemId, pawsRoot });
  return { root, pawsRoot, mirror, worktree };
}

async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(["init", "-b", "main"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "hello\n");
  await git(["-C", dir, "add", "README.md"]);
  await git([
    "-C",
    dir,
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "-m",
    "init",
  ]);
}
