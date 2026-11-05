import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { minimalAgentEnv } from "../src/acp";
import {
  holdRunnerCache,
  maintainRunnerCaches,
  pruneRunnerCaches,
  runnerCacheDirectory,
  runnerCacheEnv,
  type RunnerCacheFs,
} from "../src/runner-execution";

const DAY = 24 * 60 * 60_000;
const roots: string[] = [];

function cacheRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "paws-cache-"));
  roots.push(root);
  return join(root, "cache");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("two executions for the same repository share PAWS_CACHE_DIR and other repositories do not", () => {
  const root = cacheRoot();
  const repository = { owner: "pmdroid", repo: "paws-app" };
  const first = holdRunnerCache({ root, repository, executionId: "01J00000000000000000000001" });
  first.release();
  const second = holdRunnerCache({
    root,
    repository: { owner: "PMDroid", repo: "Paws-App" },
    executionId: "01J00000000000000000000002",
  });
  const other = holdRunnerCache({
    root,
    repository: { owner: "pmdroid", repo: "closeout" },
    executionId: "01J00000000000000000000003",
  });
  expect(second.env.PAWS_CACHE_DIR).toBe(first.env.PAWS_CACHE_DIR!);
  expect(other.env.PAWS_CACHE_DIR).not.toBe(first.env.PAWS_CACHE_DIR!);
  expect(first.directory.startsWith(`${root}/`)).toBe(true);
  for (const directory of [root, first.directory, other.directory]) {
    const info = lstatSync(directory);
    expect(info.mode & 0o7777).toBe(0o700);
    expect(info.uid).toBe(process.getuid!());
  }
  second.release();
  other.release();
});

test("the cache environment points the common tool caches into PAWS_CACHE_DIR and reaches the agent", () => {
  const directory = runnerCacheDirectory("/var/lib/paws-agent/cache", {
    owner: "pmdroid",
    repo: "paws-app",
  });
  const env = runnerCacheEnv(directory);
  expect(env).toEqual({
    PAWS_CACHE_DIR: directory,
    BUN_INSTALL_CACHE_DIR: `${directory}/bun`,
    GOMODCACHE: `${directory}/go/mod`,
    GOCACHE: `${directory}/go/build`,
    npm_config_cache: `${directory}/npm`,
    PIP_CACHE_DIR: `${directory}/pip`,
    XDG_CACHE_HOME: `${directory}/xdg`,
  });
  expect(minimalAgentEnv({ ...env, GITHUB_TOKEN: "secret" })).toEqual(env);
});

function fakeFs(entries: Record<string, number>, files: Record<string, string> = {}) {
  const removed: string[] = [];
  const renamed: string[] = [];
  const fs: RunnerCacheFs = {
    list(path) {
      const prefix = `${path}/`;
      return [
        ...new Set(
          [...Object.keys(entries), ...Object.keys(files)]
            .filter((key) => key.startsWith(prefix))
            .map((key) => key.slice(prefix.length).split("/")[0]!),
        ),
      ];
    },
    read: (path) => files[path],
    modifiedMs: (path) => entries[path],
    create(path, text) {
      if (path in files) return false;
      files[path] = text;
      return true;
    },
    rename(from) {
      renamed.push(from);
      delete entries[from];
    },
    remove(path) {
      removed.push(path);
      delete entries[path];
      delete files[path];
    },
  };
  return { fs, removed, renamed, files };
}

test("pruning deletes a tree unused for 7 days and keeps one in use", () => {
  const now = Date.UTC(2026, 10, 12);
  const [stale, held, recent, crashed, locked, abandoned] = ["a", "b", "c", "d", "e", "f"].map(
    (letter) => letter.repeat(32),
  );
  const { fs, removed, renamed, files } = fakeFs(
    {
      [`/cache/${stale}`]: now - 9 * DAY,
      [`/cache/.holds/${stale}`]: now - 7 * DAY,
      [`/cache/${held}`]: now - 30 * DAY,
      [`/cache/.holds/${held}`]: now - 30 * DAY,
      [`/cache/${recent}`]: now - 30 * DAY,
      [`/cache/.holds/${recent}`]: now - 6 * DAY,
      [`/cache/${crashed}`]: now - 8 * DAY,
      [`/cache/.holds/${crashed}`]: now - 8 * DAY,
      [`/cache/${locked}`]: now - 8 * DAY,
      [`/cache/${abandoned}`]: now - 8 * DAY,
    },
    {
      [`/cache/.holds/${held}/01J00000000000000000000001`]: "live",
      [`/cache/.holds/${crashed}/01J00000000000000000000002`]: "dead",
      [`/cache/.holds/${locked}.lock`]: "live",
      [`/cache/.holds/${abandoned}.lock`]: "dead",
    },
  );
  const deleted = pruneRunnerCaches({
    root: "/cache",
    now,
    fs,
    holder: "pruner",
    alive: (holder) => holder === "live" || holder === "pruner",
  });
  expect(deleted.sort()).toEqual(
    [stale, crashed, abandoned].map((name) => `/cache/${name}`).sort(),
  );
  expect(renamed.sort()).toEqual(deleted.sort());
  expect(removed).toContain(`/cache/.holds/${stale}`);
  expect(renamed).not.toContain(`/cache/${held}`);
  expect(renamed).not.toContain(`/cache/${recent}`);
  expect(renamed).not.toContain(`/cache/${locked}`);
  expect(files[`/cache/.holds/${locked}.lock`]).toBe("live");
  expect(Object.keys(files).filter((path) => files[path] === "pruner")).toEqual([]);
});

test("a hold waits for the tree's lock and breaks one a dead process left", () => {
  const root = cacheRoot();
  const repository = { owner: "pmdroid", repo: "paws-app" };
  const name = runnerCacheDirectory(root, repository).slice(root.length + 1);
  mkdirSync(join(root, ".holds"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, ".holds", `${name}.lock`), "pruner");
  const alive = (holder: string | undefined) => holder === "pruner";
  expect(() =>
    holdRunnerCache({
      root,
      repository,
      executionId: "01J00000000000000000000001",
      alive,
      lockWaitMs: 100,
    }),
  ).toThrow("Runner cache is locked");
  writeFileSync(join(root, ".holds", `${name}.lock`), "gone");
  const hold = holdRunnerCache({
    root,
    repository,
    executionId: "01J00000000000000000000001",
    alive,
  });
  expect(existsSync(join(root, ".holds", `${name}.lock`))).toBe(false);
  hold.release();
});

test("daily maintenance in the worker deletes old trees, read-only Go folders too, and keeps a held one", async () => {
  const root = cacheRoot();
  const old = holdRunnerCache({
    root,
    repository: { owner: "pmdroid", repo: "old" },
    executionId: "01J00000000000000000000001",
  });
  const module = join(old.env.GOMODCACHE!, "example.com", "mod@v1.0.0");
  mkdirSync(module, { recursive: true });
  writeFileSync(join(module, "go.mod"), "module example.com/mod\n");
  chmodSync(module, 0o555);
  old.release();
  const held = holdRunnerCache({
    root,
    repository: { owner: "pmdroid", repo: "held" },
    executionId: "01J00000000000000000000002",
  });
  let docker = 0;
  const errors: unknown[] = [];
  const maintain = (now: number) =>
    maintainRunnerCaches({
      root,
      now,
      pruneDocker: async () => {
        docker += 1;
        throw new Error("docker builder prune exited with 1");
      },
      onError: (error) => errors.push(error),
    });
  const start = Date.now() + 8 * DAY;
  expect(await maintain(start)).toBe(true);
  expect(existsSync(old.directory)).toBe(false);
  expect(existsSync(held.directory)).toBe(true);
  expect(readdirSync(join(root, ".trash"))).toEqual([]);
  expect(docker).toBe(1);
  expect(errors.map((error) => (error as Error).message)).toEqual([
    "docker builder prune exited with 1",
  ]);
  held.release();
  expect(await maintain(start + DAY - 1)).toBe(false);
  expect(existsSync(held.directory)).toBe(true);
  expect(await maintain(start + 8 * DAY)).toBe(true);
  expect(existsSync(held.directory)).toBe(false);
  expect(docker).toBe(2);
});
