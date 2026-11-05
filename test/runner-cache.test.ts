import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { minimalAgentEnv } from "../src/acp";
import {
  createRunnerCachePruner,
  holdRunnerCache,
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

function fakeFs(entries: Record<string, number>, holds: Record<string, string> = {}) {
  const removed: string[] = [];
  const fs: RunnerCacheFs = {
    list(path) {
      const prefix = `${path}/`;
      return [
        ...new Set(
          [...Object.keys(entries), ...Object.keys(holds)]
            .filter((key) => key.startsWith(prefix))
            .map((key) => key.slice(prefix.length).split("/")[0]!),
        ),
      ];
    },
    read: (path) => holds[path],
    modifiedMs: (path) => entries[path],
    remove(path) {
      removed.push(path);
      for (const key of Object.keys(entries)) if (key === path) delete entries[key];
    },
  };
  return { fs, removed };
}

test("pruning deletes a tree unused for 7 days and keeps one in use", () => {
  const now = Date.UTC(2026, 10, 12);
  const stale = "a".repeat(32);
  const held = "b".repeat(32);
  const recent = "c".repeat(32);
  const crashed = "d".repeat(32);
  const { fs, removed } = fakeFs(
    {
      [`/cache/${stale}`]: now - 9 * DAY,
      [`/cache/.holds/${stale}`]: now - 7 * DAY,
      [`/cache/${held}`]: now - 30 * DAY,
      [`/cache/.holds/${held}`]: now - 30 * DAY,
      [`/cache/${recent}`]: now - 30 * DAY,
      [`/cache/.holds/${recent}`]: now - 6 * DAY,
      [`/cache/${crashed}`]: now - 8 * DAY,
      [`/cache/.holds/${crashed}`]: now - 8 * DAY,
    },
    {
      [`/cache/.holds/${held}/01J00000000000000000000001`]: "live",
      [`/cache/.holds/${crashed}/01J00000000000000000000002`]: "dead",
    },
  );
  const deleted = pruneRunnerCaches({
    root: "/cache",
    now,
    fs,
    alive: (holder) => holder === "live",
  });
  expect(deleted.sort()).toEqual([`/cache/${stale}`, `/cache/${crashed}`]);
  expect(removed).toContain(`/cache/.holds/${stale}`);
  expect(removed).not.toContain(`/cache/${held}`);
  expect(removed).not.toContain(`/cache/${recent}`);
});

test("pruning removes a real tree with read-only Go module folders and keeps a held one", () => {
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
  const deleted = pruneRunnerCaches({ root, now: Date.now() + 8 * DAY });
  expect(deleted).toEqual([old.directory]);
  expect(existsSync(old.directory)).toBe(false);
  expect(existsSync(held.directory)).toBe(true);
  held.release();
  expect(pruneRunnerCaches({ root, now: Date.now() + 8 * DAY })).toEqual([held.directory]);
});

test("the daily prune runs both limits once a day", async () => {
  const now = Date.UTC(2026, 10, 12);
  const trees: number[] = [];
  let docker = 0;
  const errors: Error[] = [];
  const pruner = createRunnerCachePruner({
    now: () => now,
    pruneTrees: (at) => trees.push(at),
    pruneDocker: async () => {
      docker += 1;
      throw new Error("docker builder prune exited with 1");
    },
    onError: (error) => errors.push(error),
  });
  pruner.tick();
  await Bun.sleep(0);
  await pruner.stop();
  expect(trees).toEqual([now]);
  expect(docker).toBe(1);
  expect(errors.map((error) => error.message)).toEqual(["docker builder prune exited with 1"]);
});

test("the daily prune waits a day between runs", async () => {
  let now = Date.UTC(2026, 10, 12);
  const trees: number[] = [];
  const pruner = createRunnerCachePruner({
    now: () => now,
    pruneTrees: (at) => trees.push(at),
    pruneDocker: async () => {},
    onError: (error) => {
      throw error;
    },
  });
  pruner.tick();
  await Bun.sleep(0);
  now += DAY - 1;
  pruner.tick();
  await Bun.sleep(0);
  now += 1;
  pruner.tick();
  await Bun.sleep(0);
  expect(trees).toEqual([Date.UTC(2026, 10, 12), Date.UTC(2026, 10, 13)]);
  await pruner.stop();
});
