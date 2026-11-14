import { mkdtemp, readFile, stat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { commitCheckpoint } from "./checkpoint";
import { GitError, git } from "./git";
import { createItemCheckout, createWorktree, ensureBareMirror, removeWorktree } from "./worktree";
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

async function racedRefresh(failures: number, stderr: string) {
  const root = await mkdtemp(join(tmpdir(), "paws-wt-"));
  roots.push(root);
  const source = join(root, "checkout");
  const pawsRoot = join(root, "home", ".paws");
  await initRepo(source);
  await ensureBareMirror({ remoteUrl: source, owner: "acme", repo: "demo", pawsRoot });
  const fetches: string[][] = [];
  const networkGit = async (args: string[]) => {
    fetches.push(args);
    if (fetches.length <= failures) throw new GitError(args, 1, stderr);
    return git(args);
  };
  const refresh = ensureBareMirror({
    remoteUrl: source,
    owner: "acme",
    repo: "demo",
    pawsRoot,
    networkGit,
  });
  return { refresh, fetches, pawsRoot };
}

const RACED = "error: fetching ref refs/remotes/origin/main failed: incorrect old value provided\n";

test("a fetch that loses a ref race is retried once and the refresh continues", async () => {
  const { refresh, fetches, pawsRoot } = await racedRefresh(1, RACED);
  expect((await refresh).path).toBe(join(pawsRoot, "repos", "acme", "demo.git"));
  expect(fetches).toHaveLength(2);
  expect(fetches[1]).toEqual(fetches[0]!);
});

test("a fetch that cannot lock a ref twice fails the refresh", async () => {
  const { refresh, fetches } = await racedRefresh(
    2,
    "error: cannot lock ref 'refs/remotes/origin/main': is at 1 but expected 2\n",
  );
  await expect(refresh).rejects.toThrow("cannot lock ref");
  expect(fetches).toHaveLength(2);
});

test("a fetch that fails for another reason is not retried", async () => {
  const { refresh, fetches } = await racedRefresh(1, "fatal: repository not found\n");
  await expect(refresh).rejects.toThrow("repository not found");
  expect(fetches).toHaveLength(1);
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

test("independent item checkouts reuse WIP and clean up without creating repos", async () => {
  const root = await mkdtemp(join(tmpdir(), "paws-checkout-"));
  roots.push(root);
  const source = join(root, "source");
  await initRepo(source);
  const pawsRoot = join(root, "home");
  const options = { remoteUrl: source, pawsRoot, itemId: "ENG-9" };
  const created = await createItemCheckout(options);
  await writeFile(join(created.path, "notes.txt"), "unfinished");
  await createItemCheckout(options);
  expect(await readFile(join(created.path, "notes.txt"), "utf8")).toBe("unfinished");
  expect(await stat(join(pawsRoot, "repos")).catch(() => null)).toBeNull();
  await removeWorktree({ ...options, owner: "acme", repo: "demo" });
  expect(await stat(created.path).catch(() => null)).toBeNull();
});

test("a fresh inspection checkout fetches an unadvertised candidate before checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "paws-candidate-recovery-"));
  roots.push(root);
  const source = join(root, "source");
  await initRepo(source);
  const origin = join(root, "origin.git");
  await git(["clone", "--bare", source, origin]);
  await writeFile(join(source, "candidate.txt"), "recover this commit");
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "commit", "-m", "Candidate"]);
  const sha = (await git(["-C", source, "rev-parse", "HEAD"])).trim();
  await git(["-C", source, "push", origin, "HEAD:refs/heads/temporary"]);
  await git(["--git-dir", origin, "update-ref", "-d", "refs/heads/temporary"]);
  const pawsRoot = join(root, "home");
  let fetched = false;
  const created = await createItemCheckout({
    remoteUrl: `file://${origin}`,
    itemId: "ENG-10",
    pawsRoot,
    startRef: sha,
    async networkGit(args) {
      if (args.at(-1) === sha) {
        const path = args[1]!;
        expect(
          await git(["-C", path, "cat-file", "-e", sha]).then(
            () => true,
            () => false,
          ),
        ).toBe(false);
        fetched = true;
      }
      return git(args);
    },
  });
  expect(fetched).toBe(true);
  expect((await git(["-C", created.path, "rev-parse", "HEAD"])).trim()).toBe(sha);
  expect(await readFile(join(created.path, "candidate.txt"), "utf8")).toBe("recover this commit");
  expect(await stat(join(pawsRoot, "repos")).catch(() => null)).toBeNull();
});

test("reusing an inspection checkout refreshes main policy and preserves WIP", async () => {
  const root = await mkdtemp(join(tmpdir(), "paws-policy-refresh-"));
  roots.push(root);
  const source = join(root, "source");
  await initRepo(source);
  const options = { remoteUrl: source, pawsRoot: join(root, "home"), itemId: "ENG-11" };
  const created = await createItemCheckout(options);
  const head = (await git(["-C", created.path, "rev-parse", "HEAD"])).trim();
  await writeFile(join(created.path, "notes.txt"), "unfinished");
  await writeFile(join(source, "reviews.yaml"), "required: security\n");
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "commit", "-m", "Require security review"]);
  await createItemCheckout({ ...options, startRef: head });
  expect(await git(["-C", created.path, "show", "origin/main:reviews.yaml"])).toBe(
    "required: security\n",
  );
  expect((await git(["-C", created.path, "rev-parse", "origin/main"])).trim()).toBe(
    (await git(["-C", source, "rev-parse", "HEAD"])).trim(),
  );
  expect((await git(["-C", created.path, "rev-parse", "HEAD"])).trim()).toBe(head);
  expect(await readFile(join(created.path, "notes.txt"), "utf8")).toBe("unfinished");
  expect(await stat(join(options.pawsRoot, "repos")).catch(() => null)).toBeNull();
});

test("disabling mirrors detaches a linked worktree without losing commits or staged WIP", async () => {
  const root = await mkdtemp(join(tmpdir(), "paws-disable-mirror-"));
  roots.push(root);
  const source = join(root, "source");
  await initRepo(source);
  const options = {
    owner: "acme",
    repo: "demo",
    itemId: "ENG-12",
    pawsRoot: join(root, "home"),
    remoteUrl: source,
  };
  await ensureBareMirror(options);
  const linked = await createWorktree(options);
  await writeFile(join(linked.path, "local.txt"), "local commit");
  await git(["-C", linked.path, "add", "."]);
  await git(["-C", linked.path, "commit", "-m", "Unpublished work"]);
  const head = (await git(["-C", linked.path, "rev-parse", "HEAD"])).trim();
  await writeFile(join(linked.path, "README.md"), "staged change");
  await git(["-C", linked.path, "add", "README.md"]);
  await writeFile(join(linked.path, "README.md"), "unstaged change");
  await writeFile(join(linked.path, "untracked.txt"), "untracked");
  const status = await git(["-C", linked.path, "status", "--porcelain"]);
  await createItemCheckout(options);
  expect((await stat(join(linked.path, ".git"))).isDirectory()).toBe(true);
  await rm(join(options.pawsRoot, "repos"), { recursive: true });
  await createItemCheckout(options);
  expect((await git(["-C", linked.path, "rev-parse", "HEAD"])).trim()).toBe(head);
  expect(await git(["-C", linked.path, "status", "--porcelain"])).toBe(status);
  expect(await git(["-C", linked.path, "show", ":README.md"])).toBe("staged change");
  expect(await readFile(join(linked.path, "README.md"), "utf8")).toBe("unstaged change");
});

test("enabling mirrors preserves an existing independent item checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "paws-enable-mirror-"));
  roots.push(root);
  const source = join(root, "source");
  await initRepo(source);
  const options = {
    owner: "acme",
    repo: "demo",
    itemId: "ENG-13",
    pawsRoot: join(root, "home"),
    remoteUrl: source,
  };
  const independent = await createItemCheckout(options);
  await writeFile(join(independent.path, "notes.txt"), "unfinished");
  await ensureBareMirror(options);
  expect((await createWorktree(options)).path).toBe(independent.path);
  expect(await readFile(join(independent.path, "notes.txt"), "utf8")).toBe("unfinished");
  expect((await stat(join(independent.path, ".git"))).isDirectory()).toBe(true);
});
