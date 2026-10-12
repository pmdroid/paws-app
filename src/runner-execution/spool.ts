import {
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import { ExecutionIdSchema, RunnerJobSchema, type RunnerJob } from "./jobs";

export interface RunnerSpool {
  root: string;
  runnerUid: number;
  agentGid: number;
}

function openDirectory(path: string): number {
  return openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

function openAbsoluteDirectory(path: string): number {
  if (!isAbsolute(path) || path.split("/").some((part) => part === "." || part === ".."))
    throw new Error("Invalid runner directory path");
  let fd = openDirectory("/");
  try {
    for (const part of path.split("/").filter(Boolean)) {
      const next = openDirectory(`/proc/self/fd/${fd}/${part}`);
      closeSync(fd);
      fd = next;
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function openRoot(spool: RunnerSpool): number {
  if (
    process.platform !== "linux" ||
    !isAbsolute(spool.root) ||
    spool.root.split("/").some((part) => part === "." || part === "..") ||
    !Number.isSafeInteger(spool.runnerUid) ||
    !Number.isSafeInteger(spool.agentGid) ||
    spool.runnerUid <= 0 ||
    spool.agentGid <= 0
  )
    throw new Error("Invalid runner spool configuration");
  const fd = openAbsoluteDirectory(spool.root);
  try {
    validateDirectory(fd, spool, true);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function validateDirectory(fd: number, spool: RunnerSpool, root = false): void {
  const stat = fstatSync(fd);
  if (
    !stat.isDirectory() ||
    stat.uid !== spool.runnerUid ||
    stat.gid !== spool.agentGid ||
    !((stat.mode & 0o7777) === 0o750 || (root && (stat.mode & 0o7777) === 0o2750))
  )
    throw new Error("Unsafe runner spool directory");
}

function readBounded(file: number, limit: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.alloc(Math.min(65_536, limit - total + 1));
    let filled = 0;
    while (filled < chunk.length) {
      const count = readSync(file, chunk, filled, chunk.length - filled, total);
      if (count === 0) {
        chunks.push(chunk.subarray(0, filled));
        return Buffer.concat(chunks, total);
      }
      filled += count;
      total += count;
      if (total > limit) throw new Error("Runner input exceeds size limit");
    }
    chunks.push(chunk);
  }
}

function bundleHash(file: number): string {
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(65_536);
  let total = 0;
  while (true) {
    const count = readSync(file, chunk, 0, chunk.length, total);
    if (count === 0) return hash.digest("hex");
    total += count;
    if (total > 536_870_912) throw new Error("Runner bundle exceeds size limit");
    hash.update(chunk.subarray(0, count));
  }
}

function openBundleSource(path: string, spool: RunnerSpool): number {
  if (!isAbsolute(path) || path.endsWith("/")) throw new Error("Invalid repository bundle path");
  const directory = openAbsoluteDirectory(dirname(path));
  let source: number;
  try {
    source = openSync(
      `/proc/self/fd/${directory}/${basename(path)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } finally {
    closeSync(directory);
  }
  const info = fstatSync(source);
  if (
    !info.isFile() ||
    info.uid !== spool.runnerUid ||
    info.nlink !== 1 ||
    (info.mode & 0o7027) !== 0 ||
    info.size === 0 ||
    info.size > 536_870_912
  ) {
    closeSync(source);
    throw new Error("Unsafe repository bundle source");
  }
  return source;
}

function readJob(fd: number, spool: RunnerSpool, executionId: string): RunnerJob {
  const file = openSync(
    `/proc/self/fd/${fd}/job.json`,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(file);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== spool.runnerUid ||
      stat.gid !== spool.agentGid ||
      (stat.mode & 0o7777) !== 0o640 ||
      stat.size > 524_288
    )
      throw new Error("Unsafe runner job file");
    const job = RunnerJobSchema.parse(JSON.parse(readBounded(file, 524_288).toString("utf8")));
    if (job.executionId !== executionId) throw new Error("Runner job identity mismatch");
    if (job.command.type === "run" || job.command.type === "review") {
      const bundle = openSync(
        `/proc/self/fd/${fd}/repository.bundle`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        validateBundle(bundle, spool);
      } finally {
        closeSync(bundle);
      }
    }
    return job;
  } finally {
    closeSync(file);
  }
}

export function readRunnerJob(spool: RunnerSpool, executionId: string): RunnerJob {
  ExecutionIdSchema.parse(executionId);
  const root = openRoot(spool);
  let directory: number | undefined;
  try {
    directory = openDirectory(`/proc/self/fd/${root}/${executionId}`);
    validateDirectory(directory, spool);
    return readJob(directory, spool, executionId);
  } finally {
    if (directory !== undefined) closeSync(directory);
    closeSync(root);
  }
}

function validateBundle(file: number, spool: RunnerSpool): void {
  const info = fstatSync(file);
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.uid !== spool.runnerUid ||
    info.gid !== spool.agentGid ||
    (info.mode & 0o7777) !== 0o640 ||
    info.size === 0 ||
    info.size > 536_870_912
  )
    throw new Error("Unsafe runner repository bundle");
}

export function runnerRepositoryBundlePath(spool: RunnerSpool, executionId: string): string {
  const job = readRunnerJob(spool, executionId);
  if (job.command.type !== "run" && job.command.type !== "review")
    throw new Error("Job has no repository");
  return join(spool.root, executionId, "repository.bundle");
}

export function runnerJobDirectory(spool: RunnerSpool, executionId: string): string {
  readRunnerJob(spool, executionId);
  return join(spool.root, executionId);
}

export function publishRunnerJob(
  spool: RunnerSpool,
  input: RunnerJob,
  options: { repositoryBundle?: string } = {},
): RunnerJob {
  const job = RunnerJobSchema.parse(input);
  const needsBundle = job.command.type === "run" || job.command.type === "review";
  if (needsBundle !== (options.repositoryBundle !== undefined))
    throw new Error("Repository bundle must match job type");
  if (process.getuid?.() !== spool.runnerUid) throw new Error("Only the runner may publish jobs");
  const root = openRoot(spool);
  let directory: number | undefined;
  let staging: string | undefined;
  try {
    const path = `/proc/self/fd/${root}/${job.executionId}`;
    let existingDirectory: number | undefined;
    try {
      existingDirectory = openDirectory(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existingDirectory !== undefined) {
      try {
        validateDirectory(existingDirectory, spool);
        const existing = readJob(existingDirectory, spool, job.executionId);
        if (JSON.stringify(existing) !== JSON.stringify(job))
          throw new Error("Runner job already exists");
        if (options.repositoryBundle !== undefined) {
          const source = openBundleSource(options.repositoryBundle, spool);
          let stored: number | undefined;
          try {
            stored = openSync(
              `/proc/self/fd/${existingDirectory}/repository.bundle`,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            validateBundle(stored, spool);
            if (bundleHash(source) !== bundleHash(stored))
              throw new Error("Runner repository bundle already exists with different content");
          } finally {
            closeSync(source);
            if (stored !== undefined) closeSync(stored);
          }
        }
        return existing;
      } finally {
        closeSync(existingDirectory);
      }
    }
    staging = `/proc/self/fd/${root}/.${job.executionId}.${randomUUID()}`;
    mkdirSync(staging, { mode: 0o750 });
    directory = openDirectory(staging);
    fchownSync(directory, spool.runnerUid, spool.agentGid);
    fchmodSync(directory, 0o750);
    validateDirectory(directory, spool);
    if (options.repositoryBundle !== undefined) {
      const source = openBundleSource(options.repositoryBundle, spool);
      try {
        const destination = `/proc/self/fd/${directory}/repository.bundle`;
        const bundle = openSync(
          destination,
          constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          fchownSync(bundle, spool.runnerUid, spool.agentGid);
          fchmodSync(bundle, 0o640);
          const chunk = Buffer.alloc(65_536);
          let total = 0;
          while (true) {
            const count = readSync(source, chunk, 0, chunk.length, total);
            if (count === 0) break;
            total += count;
            if (total > 536_870_912) throw new Error("Runner bundle exceeds size limit");
            let written = 0;
            while (written < count) written += writeSync(bundle, chunk, written, count - written);
          }
          validateBundle(bundle, spool);
          fsyncSync(bundle);
        } finally {
          closeSync(bundle);
        }
      } finally {
        closeSync(source);
      }
    }
    const file = openSync(
      `/proc/self/fd/${directory}/job.json`,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o640,
    );
    try {
      fchownSync(file, spool.runnerUid, spool.agentGid);
      fchmodSync(file, 0o640);
      writeFileSync(file, JSON.stringify(job));
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    fsyncSync(directory);
    renameSync(staging, path);
    staging = undefined;
    fsyncSync(root);
    return job;
  } finally {
    if (directory !== undefined) closeSync(directory);
    if (staging !== undefined) rmSync(staging, { recursive: true, force: true });
    closeSync(root);
  }
}
