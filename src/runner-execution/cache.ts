import { journalCaught } from "../journal";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { chmod, lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ExecutionIdSchema } from "./jobs";
import { startTime } from "./processes";
import { runnerDockerEnv } from "./supervisor";

export const RUNNER_CACHE_ROOT = "/var/lib/paws-agent/cache";
export const RUNNER_CACHE_UNUSED_MS = 7 * 24 * 60 * 60_000;
export const RUNNER_CACHE_PRUNE_INTERVAL_MS = 24 * 60 * 60_000;
export const RUNNER_DOCKER_BUILD_CACHE_KEEP = "20GB";

const TREE = /^[a-f0-9]{32}$/;
const HOLDS = ".holds";
const TRASH = ".trash";
const PRUNED = ".pruned";
const LOCK_WAIT_MS = 30_000;

export function runnerCacheDirectory(
  root: string,
  repository: { owner: string; repo: string },
): string {
  const key = `${repository.owner}/${repository.repo}`.toLowerCase();
  return join(root, createHash("sha256").update(key).digest("hex").slice(0, 32));
}

export function runnerCacheEnv(directory: string): Record<string, string> {
  return {
    PAWS_CACHE_DIR: directory,
    BUN_INSTALL_CACHE_DIR: join(directory, "bun"),
    GOMODCACHE: join(directory, "go", "mod"),
    GOCACHE: join(directory, "go", "build"),
    npm_config_cache: join(directory, "npm"),
    PIP_CACHE_DIR: join(directory, "pip"),
    XDG_CACHE_HOME: join(directory, "xdg"),
  };
}

function privateDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    journalCaught(error, "cache.privateDirectory.mkdirSync", null, "path may already exist");
  }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.())
    throw new Error("Runner cache directory is not private");
  if ((info.mode & 0o7777) !== 0o700) chmodSync(path, 0o700);
}

export type RunnerCacheFs = {
  list(path: string): string[];
  read(path: string): string | undefined;
  modifiedMs(path: string): number | undefined;
  create(path: string, text: string): boolean;
  rename(from: string, to: string): void;
  remove(path: string): void;
};

type Alive = (holder: string | undefined) => boolean;

function holderAlive(text: string | undefined): boolean {
  const [pid, born] = (text ?? "").trim().split(" ");
  const id = Number(pid);
  return Boolean(born) && Number.isSafeInteger(id) && id > 1 && startTime(id) === born;
}

function currentHolder(): string {
  return `${process.pid} ${startTime(process.pid) ?? ""}\n`;
}

function tryLock(fs: RunnerCacheFs, lock: string, holder: string, alive: Alive): boolean {
  if (fs.create(lock, holder)) return true;
  if (alive(fs.read(lock))) return false;
  fs.remove(lock);
  return fs.create(lock, holder);
}

function treeLock(root: string, name: string): string {
  return join(root, HOLDS, `${name}.lock`);
}

export type RunnerCacheHold = {
  directory: string;
  env: Record<string, string>;
  release(): void;
};

export function holdRunnerCache(options: {
  root: string;
  repository: { owner: string; repo: string };
  executionId: string;
  holder?: string;
  alive?: Alive;
  lockWaitMs?: number;
}): RunnerCacheHold {
  const executionId = ExecutionIdSchema.parse(options.executionId);
  const directory = runnerCacheDirectory(options.root, options.repository);
  const name = directory.slice(options.root.length + 1);
  const holds = join(options.root, HOLDS, name);
  const holder = options.holder ?? currentHolder();
  const alive = options.alive ?? holderAlive;
  privateDirectory(options.root);
  privateDirectory(join(options.root, HOLDS));
  const lock = treeLock(options.root, name);
  const deadline = Date.now() + (options.lockWaitMs ?? LOCK_WAIT_MS);
  while (!tryLock(nodeCacheFs, lock, holder, alive)) {
    if (Date.now() >= deadline) throw new Error("Runner cache is locked");
    Bun.sleepSync(50);
  }
  const hold = join(holds, executionId);
  const used = () => {
    const now = new Date();
    utimesSync(holds, now, now);
  };
  try {
    privateDirectory(holds);
    const fd = openSync(
      hold,
      constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(fd, holder);
    } finally {
      closeSync(fd);
    }
    used();
    privateDirectory(directory);
  } finally {
    rmSync(lock, { force: true });
  }
  return {
    directory,
    env: runnerCacheEnv(directory),
    release() {
      rmSync(hold, { force: true });
      try {
        used();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        journalCaught(error, "cache.holdRunnerCache.release", null, "holds may be gone");
      }
    },
  };
}

export function pruneRunnerCaches(options: {
  root: string;
  now: number;
  fs?: RunnerCacheFs;
  alive?: Alive;
  holder?: string;
}): string[] {
  const fs = options.fs ?? nodeCacheFs;
  const alive = options.alive ?? holderAlive;
  const holder = options.holder ?? currentHolder();
  const removed: string[] = [];
  for (const name of fs.list(options.root)) {
    if (!TREE.test(name)) continue;
    const tree = join(options.root, name);
    const holds = join(options.root, HOLDS, name);
    const lock = treeLock(options.root, name);
    if (!tryLock(fs, lock, holder, alive)) continue;
    try {
      if (fs.list(holds).some((id) => alive(fs.read(join(holds, id))))) continue;
      const used = fs.modifiedMs(holds) ?? fs.modifiedMs(tree);
      if (used !== undefined && options.now - used < RUNNER_CACHE_UNUSED_MS) continue;
      fs.rename(tree, join(options.root, TRASH, `${name}-${randomUUID()}`));
      fs.remove(holds);
      removed.push(tree);
    } finally {
      fs.remove(lock);
    }
  }
  return removed;
}

function removeTree(path: string): void {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return;
  if (!info.isDirectory()) return unlinkSync(path);
  if ((info.mode & 0o700) !== 0o700) chmodSync(path, 0o700);
  for (const entry of readdirSync(path)) removeTree(join(path, entry));
  rmdirSync(path);
}

async function removeTreeAsync(path: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (!info) return;
  if (!info.isDirectory()) return unlink(path);
  if ((info.mode & 0o700) !== 0o700) await chmod(path, 0o700);
  for (const entry of await readdir(path)) await removeTreeAsync(join(path, entry), signal);
  await rmdir(path);
}

const nodeCacheFs: RunnerCacheFs = {
  list(path) {
    try {
      return readdirSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      journalCaught(error, "cache.nodeCacheFs.list", null, "optional directory may be absent");
      return [];
    }
  },
  read(path) {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      journalCaught(error, "cache.nodeCacheFs.read", null, "file may have been removed");
      return;
    }
  },
  modifiedMs: (path) => lstatSync(path, { throwIfNoEntry: false })?.mtimeMs,
  create(path, text) {
    let fd: number;
    try {
      fd = openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      journalCaught(error, "cache.nodeCacheFs.create", null, "lock may be held");
      return false;
    }
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
    return true;
  },
  rename(from, to) {
    try {
      renameSync(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      journalCaught(error, "cache.nodeCacheFs.rename", null, "tree may be gone");
    }
  },
  remove: removeTree,
};

export async function pruneDockerBuildCache(
  options: { env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<"pruned" | "no-daemon"> {
  const docker = options.env ?? runnerDockerEnv();
  if (!docker.DOCKER_HOST) return "no-daemon";
  const argv = ["builder", "prune", "--force", "--keep-storage", RUNNER_DOCKER_BUILD_CACHE_KEEP];
  await new Promise<void>((resolve, reject) => {
    const child = spawn("docker", argv, {
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        DOCKER_HOST: docker.DOCKER_HOST,
      },
      stdio: ["ignore", "ignore", "pipe"],
      timeout: options.timeoutMs ?? 30 * 60_000,
      killSignal: "SIGKILL",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2000);
    });
    child.on("error", reject);
    child.on("close", (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `docker builder prune exited with ${signal ?? code}${stderr ? `: ${stderr.trim()}` : ""}`,
            ),
          ),
    );
  });
  return "pruned";
}

export async function maintainRunnerCaches(options: {
  root?: string;
  now?: number;
  signal?: AbortSignal;
  pruneDocker?: (signal?: AbortSignal) => Promise<unknown>;
  onError: (error: unknown) => void;
}): Promise<boolean> {
  const root = options.root ?? RUNNER_CACHE_ROOT;
  const now = options.now ?? Date.now();
  const stamp = join(root, PRUNED);
  const last = nodeCacheFs.modifiedMs(stamp);
  if (last !== undefined && now - last < RUNNER_CACHE_PRUNE_INTERVAL_MS) return false;
  try {
    privateDirectory(root);
    privateDirectory(join(root, HOLDS));
    privateDirectory(join(root, TRASH));
    rmSync(stamp, { force: true });
    nodeCacheFs.create(stamp, "");
    const at = new Date(now);
    utimesSync(stamp, at, at);
    pruneRunnerCaches({ root, now });
  } catch (error) {
    options.onError(error);
  }
  const trash = join(root, TRASH);
  for (const entry of nodeCacheFs.list(trash)) {
    if (options.signal?.aborted) break;
    await removeTreeAsync(join(trash, entry), options.signal).catch((error: unknown) => {
      if (!options.signal?.aborted) options.onError(error);
    });
  }
  if (!options.signal?.aborted)
    await (options.pruneDocker ?? ((signal) => pruneDockerBuildCache({ signal })))(
      options.signal,
    ).catch((error: unknown) => {
      if (!options.signal?.aborted) options.onError(error);
    });
  return true;
}
