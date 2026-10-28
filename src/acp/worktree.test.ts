import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { commitCheckpoint } from "./checkpoint";
import { git } from "./git";
import { createWorktree, ensureBareMirror, removeWorktree } from "./worktree";
import { branchName } from "./paths";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("bare mirror and worktree stay off the developer checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "paws-wt-"));
  roots.push(root);
  const source = join(root, "checkout");
  const pawsRoot = join(root, "home", ".paws");
  await initRepo(source);

  const mirror = await ensureBareMirror({
    remoteUrl: source,
    owner: "acme",
    repo: "demo",
    pawsRoot,
  });
  const worktree = await createWorktree({
    owner: "acme",
    repo: "demo",
    itemId: "ENG-7",
    pawsRoot,
  });

  expect(worktree.branch).toBe(branchName("ENG-7"));
  expect(worktree.path).toBe(join(pawsRoot, "worktrees", "ENG-7"));
  expect(await readFile(join(worktree.path, "README.md"), "utf8")).toBe("hello\n");
  expect((await git(["-C", source, "status", "--porcelain"])).trim()).toBe("");
  expect((await git(["-C", source, "branch", "--show-current"])).trim()).toBe("main");

  await writeFile(join(worktree.path, "notes.txt"), "wip\n");
  const checkpoint = await commitCheckpoint(worktree.path, "wip: ENG-7 checkpoint");
  expect(checkpoint.committed).toBe(true);
  expect(await readFile(join(worktree.path, "notes.txt"), "utf8")).toBe("wip\n");
  expect((await git(["-C", worktree.path, "log", "-1", "--format=%s"])).trim()).toBe(
    "wip: ENG-7 checkpoint",
  );

  const again = await createWorktree({
    owner: "acme",
    repo: "demo",
    itemId: "ENG-7",
    pawsRoot,
  });
  expect(again.path).toBe(worktree.path);

  await removeWorktree({ owner: "acme", repo: "demo", itemId: "ENG-7", pawsRoot });
  const stillThere = (
    await git(["--git-dir", mirror.path, "rev-parse", "--verify", worktree.branch])
  ).trim();
  if (!checkpoint.sha) throw new Error("checkpoint did not record a sha");
  expect(stillThere).toBe(checkpoint.sha);
}, 20_000);

test("a worktree starts from a continued branch's tip and never falls back to main", async () => {
  const root = await mkdtemp(join(tmpdir(), "paws-wt-"));
  roots.push(root);
  const source = join(root, "checkout");
  const pawsRoot = join(root, "home", ".paws");
  await initRepo(source);
  await git(["checkout", "-qb", "paws/eng-7"], { cwd: source });
  await writeFile(join(source, "earlier.txt"), "earlier work\n");
  await git(["add", "earlier.txt"], { cwd: source });
  await git(
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "earlier"],
    { cwd: source },
  );
  const tip = (await git(["-C", source, "rev-parse", "HEAD"])).trim();
  await git(["checkout", "-q", "main"], { cwd: source });
  await ensureBareMirror({ remoteUrl: source, owner: "acme", repo: "demo", pawsRoot });

  const continued = await createWorktree({
    owner: "acme",
    repo: "demo",
    itemId: "ENG-7-NEXT",
    pawsRoot,
    startRef: "origin/paws/eng-7",
  });
  expect((await git(["-C", continued.path, "rev-parse", "HEAD"])).trim()).toBe(tip);

  // Starting from main would push over the earlier branch's commits.
  await expect(
    createWorktree({
      owner: "acme",
      repo: "demo",
      itemId: "ENG-7-GONE",
      pawsRoot,
      startRef: "origin/paws/eng-7-missing",
    }),
  ).rejects.toThrow("origin/paws/eng-7-missing");
}, 20_000);

async function initRepo(dir: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
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

test("concurrent mirror refreshes fetch one at a time", async () => {
  const root = await mkdtemp(join(tmpdir(), "paws-wt-"));
  roots.push(root);
  const source = join(root, "checkout");
  const pawsRoot = join(root, "home", ".paws");
  await initRepo(source);
  await ensureBareMirror({ remoteUrl: source, owner: "acme", repo: "demo", pawsRoot });
  let active = 0;
  let overlapped = 0;
  const networkGit = async (args: string[]) => {
    active++;
    if (active > 1) overlapped++;
    await Bun.sleep(20);
    try {
      return await git(args);
    } finally {
      active--;
    }
  };
  await Promise.all(
    Array.from({ length: 4 }, () =>
      ensureBareMirror({ remoteUrl: source, owner: "acme", repo: "demo", pawsRoot, networkGit }),
    ),
  );
  expect(overlapped).toBe(0);
});

test("a worktree waits for an in-flight mirror refresh before touching the mirror config", async () => {
  const root = await mkdtemp(join(tmpdir(), "paws-wt-"));
  roots.push(root);
  const source = join(root, "checkout");
  const pawsRoot = join(root, "home", ".paws");
  await initRepo(source);
  await ensureBareMirror({ remoteUrl: source, owner: "acme", repo: "demo", pawsRoot });
  const fetching = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const refresh = ensureBareMirror({
    remoteUrl: source,
    owner: "acme",
    repo: "demo",
    pawsRoot,
    networkGit: async (args) => {
      fetching.resolve();
      await release.promise;
      return git(args);
    },
  });
  await fetching.promise;
  let added = false;
  const worktree = createWorktree({ owner: "acme", repo: "demo", itemId: "ENG-8", pawsRoot }).then(
    (created) => {
      added = true;
      return created;
    },
  );
  await Promise.race([worktree, Bun.sleep(500)]);
  expect(added).toBe(false);
  release.resolve();
  await refresh;
  expect((await worktree).branch).toBe(branchName("ENG-8"));
});
