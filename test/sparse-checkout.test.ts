import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createWorktree, ensureBareMirror, commitCheckpoint } from "../src/acp";
import { journalRetiredProjectSettings, parseConfigToml } from "../src/config";
import { checkoutPatterns, exclusionPatterns } from "../src/worktree-checkout";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function git(tree: string, ...args: string[]): string {
  return execFileSync("git", ["-C", tree, ...args], { encoding: "utf8" }).trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "paws-sparse-"));
  roots.push(root);
  const source = join(root, "source");
  const pawsRoot = join(root, "paws");
  await mkdir(source);
  git(source, "init", "-b", "main");
  for (const folder of [
    "large",
    "nested/omit",
    "nested/keep",
    "literal[1]",
    "literal1",
    "space folder",
  ]) {
    await mkdir(join(source, folder), { recursive: true });
    await writeFile(join(source, folder, "file.txt"), folder);
  }
  await writeFile(join(source, "README.md"), "original");
  git(source, "add", ".");
  git(
    source,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "initial",
  );
  const mirror = await ensureBareMirror({
    remoteUrl: source,
    owner: "acme",
    repo: "demo",
    pawsRoot,
  });
  const create = (itemId = "ONE", checkoutExclusions?: string[]) =>
    createWorktree({
      owner: "acme",
      repo: "demo",
      pawsRoot,
      itemId,
      ...(checkoutExclusions ? { checkoutExclusions } : {}),
    });
  return { root, source, pawsRoot, mirror, create };
}

test("sparse worktrees exclude literal nested folders and keep omissions out of commits", async () => {
  const f = await fixture();
  const originalConfig = await readFile(join(f.source, ".git/config"), "utf8");
  const tree = await f.create("ONE", ["large", "nested/omit", "literal[1]", "space folder"]);
  for (const folder of ["large", "nested/omit", "literal[1]", "space folder"]) {
    expect(existsSync(join(tree.path, folder))).toBe(false);
  }
  expect(await readFile(join(tree.path, "nested/keep/file.txt"), "utf8")).toBe("nested/keep");
  expect(existsSync(join(tree.path, "literal1/file.txt"))).toBe(true);
  expect(git(tree.path, "status", "--porcelain")).toBe("");
  await writeFile(join(tree.path, "README.md"), "change");
  expect((await commitCheckpoint(tree.path, "change")).committed).toBe(true);
  expect(git(tree.path, "diff", "HEAD~", "--name-only")).toBe("README.md");
  expect(git(tree.path, "show", "HEAD:large/file.txt")).toBe("large");
  expect(await readFile(join(f.source, ".git/config"), "utf8")).toBe(originalConfig);
  expect(git(f.source, "status", "--porcelain")).toBe("");
  expect(await readFile(join(f.source, "large/file.txt"), "utf8")).toBe("large");
});

test("worktree exclusions do not bleed and changed exclusions preserve dirty files", async () => {
  const f = await fixture();
  const one = await f.create("ONE", ["large"]);
  const two = await f.create("TWO", ["nested/omit"]);
  expect(existsSync(join(one.path, "large"))).toBe(false);
  expect(existsSync(join(two.path, "large"))).toBe(true);
  expect(existsSync(join(two.path, "nested/omit"))).toBe(false);
  expect(git(f.mirror.path, "config", "--get", "core.bare")).toBe("true");
  await writeFile(join(one.path, "README.md"), "unsaved");
  await writeFile(join(one.path, "nested/omit/file.txt"), "unsaved excluded");
  await f.create("ONE", ["nested/omit"]);
  expect(await readFile(join(one.path, "README.md"), "utf8")).toBe("unsaved");
  expect(await readFile(join(one.path, "nested/omit/file.txt"), "utf8")).toBe("unsaved excluded");
  expect(existsSync(join(one.path, "large"))).toBe(true);
  await f.create("TWO");
  expect(existsSync(join(two.path, "nested/omit"))).toBe(true);
  expect(git(two.path, "status", "--porcelain")).toBe("");
});

test("detached verification applies the run's exclusions", async () => {
  const f = await fixture();
  const one = await f.create("ONE", ["large"]);
  const detached = join(f.root, "detached");
  git(one.path, "worktree", "add", "--no-checkout", "--detach", detached, "HEAD");
  await checkoutPatterns(detached, exclusionPatterns(["large"]));
  expect(existsSync(join(detached, "large"))).toBe(false);
  expect(existsSync(join(detached, "README.md"))).toBe(true);
  expect(git(detached, "status", "--porcelain")).toBe("");
});

test("reuse finishes a worktree left unpopulated during creation", async () => {
  const f = await fixture();
  const target = join(f.pawsRoot, "worktrees", "ONE");
  await mkdir(join(f.pawsRoot, "worktrees"));
  git(f.mirror.path, "worktree", "add", "--no-checkout", "-b", "paws/ONE", target, "origin/main");
  await f.create("ONE", ["large"]);
  expect(existsSync(join(target, "large"))).toBe(false);
  expect(existsSync(join(target, "README.md"))).toBe(true);
  expect(git(target, "status", "--porcelain")).toBe("");
});

test("an old checkout.projects table loads, is ignored and is journaled", async () => {
  const f = await fixture();
  const configPath = join(f.pawsRoot, "config.toml");
  await writeFile(configPath, '[checkout.projects."Acme/Demo"]\nexclude = ["large"]\n');
  const tree = await f.create();
  expect(existsSync(join(tree.path, "large/file.txt"))).toBe(true);
  expect(git(tree.path, "status", "--porcelain")).toBe("");
  const lines: string[] = [];
  journalRetiredProjectSettings(configPath, (line) => lines.push(line));
  expect(lines).toEqual(["checkout.projects is no longer supported"]);
});

test("excluded files are never passed through checkout filters", async () => {
  const f = await fixture();
  await writeFile(join(f.source, ".gitattributes"), "large/** filter=probe\n");
  git(f.source, "add", ".gitattributes");
  git(
    f.source,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "filter",
  );
  await ensureBareMirror({
    remoteUrl: f.source,
    owner: "acme",
    repo: "demo",
    pawsRoot: f.pawsRoot,
  });
  const touched = join(f.root, "filter-ran");
  git(f.mirror.path, "config", "filter.probe.smudge", `touch ${touched}; cat`);
  const tree = await f.create("ONE", ["large"]);
  expect(existsSync(touched)).toBe(false);
  expect(existsSync(join(tree.path, "README.md"))).toBe(true);
  await f.create("FULL");
  expect(existsSync(touched)).toBe(true);
});

test("legacy config without sparse settings retains its existing parsing behavior", () => {
  const config = parseConfigToml("[caps]\nmax_awake_ms = 3\nmax_awake_ms = 7\n");
  expect(config.maxAwakeMs).toBe(7);
});
