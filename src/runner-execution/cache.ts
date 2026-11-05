import { journalCaught } from "../journal";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from "node:fs";
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

export type RunnerCacheHold = {
  directory: string;
  env: Record<string, string>;
  release(): void;
};

export function holdRunnerCache(options: {
  root: string;
  repository: { owner: string; repo: string };
  executionId: string;
  holder?: { pid: number; born: string };
}): RunnerCacheHold {
  const executionId = ExecutionIdSchema.parse(options.executionId);
  const directory = runnerCacheDirectory(options.root, options.repository);
  const holds = join(options.root, HOLDS, directory.slice(options.root.length + 1));
  const holder = options.holder ?? { pid: process.pid, born: startTime(process.pid) ?? "" };
  privateDirectory(options.root);
  privateDirectory(join(options.root, HOLDS));
  privateDirectory(holds);
  const hold = join(holds, executionId);
  const fd = openSync(
    hold,
    constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, `${holder.pid} ${holder.born}\n`);
  } finally {
    closeSync(fd);
  }
  const used = () => {
    const now = new Date();
    utimesSync(holds, now, now);
  };
  used();
  privateDirectory(directory);
  return {
    directory,
    env: runnerCacheEnv(directory),
    release() {
      rmSync(hold, { force: true });
      used();
    },
  };
}

export type RunnerCacheFs = {
  list(path: string): string[];
  read(path: string): string | undefined;
  modifiedMs(path: string): number | undefined;
  remove(path: string): void;
};

function holderAlive(text: string | undefined): boolean {
  const [pid, born] = (text ?? "").trim().split(" ");
  const id = Number(pid);
  return Boolean(born) && Number.isSafeInteger(id) && id > 1 && startTime(id) === born;
}

export function pruneRunnerCaches(options: {
  root: string;
  now: number;
  fs?: RunnerCacheFs;
  alive?: (holder: string | undefined) => boolean;
}): string[] {
  const fs = options.fs ?? nodeCacheFs;
  const alive = options.alive ?? holderAlive;
  const removed: string[] = [];
  for (const name of fs.list(options.root)) {
    if (!TREE.test(name)) continue;
    const tree = join(options.root, name);
    const holds = join(options.root, HOLDS, name);
    if (fs.list(holds).some((id) => alive(fs.read(join(holds, id))))) continue;
    const used = fs.modifiedMs(holds) ?? fs.modifiedMs(tree);
    if (used !== undefined && options.now - used < RUNNER_CACHE_UNUSED_MS) continue;
    fs.remove(tree);
    fs.remove(holds);
    removed.push(tree);
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
      journalCaught(error, "cache.nodeCacheFs.read", null, "hold may have been released");
      return;
    }
  },
  modifiedMs: (path) => lstatSync(path, { throwIfNoEntry: false })?.mtimeMs,
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

export function createRunnerCachePruner(options: {
  root?: string;
  now?: () => number;
  pruneTrees?: (now: number) => unknown;
  pruneDocker?: (signal: AbortSignal) => Promise<unknown>;
  onError: (error: Error) => void;
}) {
  const root = options.root ?? RUNNER_CACHE_ROOT;
  const now = options.now ?? Date.now;
  const pruneTrees = options.pruneTrees ?? ((at: number) => pruneRunnerCaches({ root, now: at }));
  const pruneDocker =
    options.pruneDocker ?? ((signal: AbortSignal) => pruneDockerBuildCache({ signal }));
  const abort = new AbortController();
  const fail = (error: unknown) =>
    options.onError(error instanceof Error ? error : new Error("Runner cache prune failed"));
  let last: number | undefined;
  let running: Promise<void> | undefined;
  return {
    tick(): void {
      const at = now();
      if (
        abort.signal.aborted ||
        running ||
        (last !== undefined && at - last < RUNNER_CACHE_PRUNE_INTERVAL_MS)
      )
        return;
      last = at;
      running = (async () => {
        try {
          pruneTrees(at);
        } catch (error) {
          fail(error);
        }
        await pruneDocker(abort.signal).catch((error: unknown) => {
          if (!abort.signal.aborted) fail(error);
        });
      })().finally(() => {
        running = undefined;
      });
    },
    stop: async () => {
      abort.abort();
      await running;
    },
  };
}
