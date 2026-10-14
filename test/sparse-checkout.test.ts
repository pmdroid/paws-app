import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  createWorktree,
  ensureBareMirror,
  commitCheckpoint,
  restartFromFreshMain,
} from "../src/acp";
import { parseConfigToml, renderConfigToml, writeConfigFile } from "../src/config";
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
  const settings = async (exclude: string[]) => {
    await writeFile(
      join(pawsRoot, "config.toml"),
      `[checkout.projects."Acme/Demo"]\nexclude = ${JSON.stringify(exclude)}\n`,
    );
  };
  const create = (itemId = "ONE") =>
    createWorktree({ owner: "acme", repo: "demo", pawsRoot, itemId });
  return { root, source, pawsRoot, mirror, settings, create };
}

test("sparse worktrees exclude literal nested folders and keep omissions out of commits", async () => {
  const f = await fixture();
  const originalConfig = await readFile(join(f.source, ".git/config"), "utf8");
  await f.settings(["large", "nested/omit", "literal[1]", "space folder"]);
  const tree = await f.create();
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

test("worktree settings do not bleed and config changes preserve dirty files", async () => {
  const f = await fixture();
  await f.settings(["large"]);
  const one = await f.create();
  await f.settings(["nested/omit"]);
  const two = await f.create("TWO");
  expect(existsSync(join(one.path, "large"))).toBe(false);
  expect(existsSync(join(two.path, "large"))).toBe(true);
  expect(existsSync(join(two.path, "nested/omit"))).toBe(false);
  expect(git(f.mirror.path, "config", "--get", "core.bare")).toBe("true");
  await writeFile(join(one.path, "README.md"), "unsaved");
  await writeFile(join(one.path, "nested/omit/file.txt"), "unsaved excluded");
  await f.create();
  expect(await readFile(join(one.path, "README.md"), "utf8")).toBe("unsaved");
  expect(await readFile(join(one.path, "nested/omit/file.txt"), "utf8")).toBe("unsaved excluded");
  expect(existsSync(join(one.path, "large"))).toBe(true);
  await f.settings([]);
  await f.create("TWO");
  expect(existsSync(join(two.path, "nested/omit"))).toBe(true);
  expect(git(two.path, "status", "--porcelain")).toBe("");
});

test("fresh-main recovery and detached verification apply configured exclusions", async () => {
  const f = await fixture();
  await f.settings(["large"]);
  const one = await f.create();
  const detached = join(f.root, "detached");
  git(one.path, "worktree", "add", "--no-checkout", "--detach", detached, "HEAD");
  await checkoutPatterns(detached, exclusionPatterns(["large"]));
  expect(existsSync(join(detached, "large"))).toBe(false);
  expect(existsSync(join(detached, "README.md"))).toBe(true);
  expect(git(detached, "status", "--porcelain")).toBe("");
  const result = restartFromFreshMain({
    pawsRoot: f.pawsRoot,
    owner: "acme",
    repo: "demo",
    itemId: "ONE",
    wipBranch: one.branch,
  });
  expect(result.restarted).toBe(true);
  expect(existsSync(join(one.path, "large"))).toBe(false);
  expect(git(one.path, "status", "--porcelain")).toBe("");
});

test("reuse finishes a worktree left unpopulated during creation", async () => {
  const f = await fixture();
  await f.settings(["large"]);
  const target = join(f.pawsRoot, "worktrees", "ONE");
  await mkdir(join(f.pawsRoot, "worktrees"));
  git(f.mirror.path, "worktree", "add", "--no-checkout", "-b", "paws/ONE", target, "origin/main");
  await f.create();
  expect(existsSync(join(target, "large"))).toBe(false);
  expect(existsSync(join(target, "README.md"))).toBe(true);
  expect(git(target, "status", "--porcelain")).toBe("");
});

test("checkout config rejects unsafe folders and setup preserves project exclusions", async () => {
  for (const path of [
    "",
    "/absolute",
    "..",
    "foo/../bar",
    "foo//bar",
    ".git",
    "foo/.git",
    "foo\\bar",
  ]) {
    expect(() =>
      parseConfigToml(`[checkout.projects."acme/demo"]\nexclude = ${JSON.stringify([path])}`),
    ).toThrow();
  }
  expect(() => parseConfigToml('[checkout.projects."acme/demo"]\nexclude = "large"')).toThrow();
  const f = await fixture();
  const setup = {
    linearMode: "comments" as const,
    linearTeam: "ENG",
    linearTeamId: "team",
    linearViewerId: "viewer",
    linearSecret: "secrets/linear",
    linearClientFile: null,
    githubAuth: "gh" as const,
    repo: "acme/demo",
    checkout: f.source,
    maxTurns: 5,
    maxAwakeMs: 5000,
    implementer: "claude" as const,
  };
  await writeFile(
    join(f.pawsRoot, "config.toml"),
    `${renderConfigToml(setup)}\n[checkout.projects."Acme/Demo"]\nexclude = ["large"]\n`,
  );
  writeConfigFile(join(f.pawsRoot, "config.toml"), setup);
  expect(
    parseConfigToml(await readFile(join(f.pawsRoot, "config.toml"), "utf8")).checkoutProjects,
  ).toEqual({ "acme/demo": { exclude: ["large"] } });
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
  await f.settings(["large"]);
  const tree = await f.create();
  expect(existsSync(touched)).toBe(false);
  expect(existsSync(join(tree.path, "README.md"))).toBe(true);
  await f.settings([]);
  await f.create("FULL");
  expect(existsSync(touched)).toBe(true);
});

test("legacy config without sparse settings retains its existing parsing behavior", () => {
  const config = parseConfigToml("[caps]\nmax_turns = 3\nmax_turns = 7\n");
  expect(config.maxTurns).toBe(7);
  expect(config.checkoutProjects).toBeUndefined();
});

test("failed fresh-main population preserves saved WIP through retry", async () => {
  const f = await fixture();
  await writeFile(join(f.source, ".gitattributes"), "README.md filter=probe\n");
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
  const tree = await f.create();
  await writeFile(join(tree.path, "README.md"), "saved work");
  git(f.mirror.path, "config", "filter.probe.clean", "cat");
  git(f.mirror.path, "config", "filter.probe.smudge", "false");
  git(f.mirror.path, "config", "filter.probe.required", "true");
  const restart = () =>
    restartFromFreshMain({
      pawsRoot: f.pawsRoot,
      owner: "acme",
      repo: "demo",
      itemId: "ONE",
      wipBranch: tree.branch,
    });
  expect(restart).toThrow();
  expect(git(f.mirror.path, "worktree", "list", "--porcelain")).not.toContain(tree.path);
  git(f.mirror.path, "config", "filter.probe.smudge", "cat");
  expect(restart().restarted).toBe(true);
  expect(git(f.mirror.path, "show", `${tree.branch}:README.md`)).toBe("saved work");
});
