import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ExecutionIdSchema } from "./jobs";
import { openSharedDirectory, sharedDirectoryAllowed, type SharedDirectoryRule } from "./shared";
import { RUNNER_ARTIFACT_LIMITS, RunnerArtifactSchema } from "../runner-protocol";

export interface RunnerResults {
  root: string;
  runnerUid?: number;
  agentUid: number;
  resultsGid: number;
}

export function runnerResultsRootRule(options: RunnerResults): SharedDirectoryRule {
  return { owners: [options.runnerUid ?? options.agentUid], gid: options.resultsGid, mode: 0o770 };
}

export function runnerResultDirectoryRule(options: RunnerResults): SharedDirectoryRule {
  return { owners: [options.agentUid], gid: options.resultsGid, mode: 0o750 };
}

function openResultsRoot(options: RunnerResults): number {
  if (
    process.platform !== "linux" ||
    !isAbsolute(options.root) ||
    options.root.split("/").some((part) => part === "." || part === "..") ||
    !Number.isSafeInteger(options.agentUid) ||
    !Number.isSafeInteger(options.resultsGid) ||
    options.agentUid <= 0 ||
    options.resultsGid <= 0
  )
    throw new Error("Invalid runner results configuration");
  let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const part of options.root.split("/").filter(Boolean)) {
      const next = openSync(
        `/proc/self/fd/${fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      closeSync(fd);
      fd = next;
    }
    if (!sharedDirectoryAllowed(fstatSync(fd), runnerResultsRootRule(options)))
      throw new Error("Unsafe runner results root");
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function checkResults(options: RunnerResults, directory: number): number {
  if (!sharedDirectoryAllowed(fstatSync(directory), runnerResultDirectoryRule(options))) {
    closeSync(directory);
    throw new Error("Unsafe runner results directory");
  }
  return directory;
}

function openResults(options: RunnerResults, executionId: string): number {
  ExecutionIdSchema.parse(executionId);
  const root = openResultsRoot(options);
  let directory: number;
  try {
    directory = openSync(
      `/proc/self/fd/${root}/${executionId}`,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } finally {
    closeSync(root);
  }
  return checkResults(options, directory);
}

export function createRunnerResultDirectory(options: RunnerResults, executionId: string): string {
  ExecutionIdSchema.parse(executionId);
  const root = openResultsRoot(options);
  let directory: number;
  try {
    directory = openSharedDirectory(root, executionId, options.resultsGid, 0o750);
  } finally {
    closeSync(root);
  }
  closeSync(checkResults(options, directory));
  return join(options.root, executionId);
}

export function runnerResultDirectory(options: RunnerResults, executionId: string): string {
  const fd = openResults(options, executionId);
  closeSync(fd);
  return join(options.root, executionId);
}

export function readRunnerResultFile(
  options: RunnerResults,
  executionId: string,
  name:
    | "candidate.bundle"
    | "events.jsonl"
    | "result.json"
    | "retro-result.json"
    | "runtimes.json"
    | "session.json"
    | `artifact-${string}.bytes`
    | `checkpoint-${string}.bundle`,
): Buffer {
  const limits = {
    "candidate.bundle": 536_870_912,
    "events.jsonl": 16_777_216,
    "result.json": 1_048_576,
    "retro-result.json": 1_048_576,
    "runtimes.json": 65_536,
    "session.json": 65_536,
  };
  const limit = Object.hasOwn(limits, name)
    ? limits[name as keyof typeof limits]
    : name.startsWith("artifact-") &&
        name.endsWith(".bytes") &&
        RunnerArtifactSchema.shape.id.safeParse(name.slice(9, -6)).success
      ? RUNNER_ARTIFACT_LIMITS.video
      : /^checkpoint-[a-f0-9]{40}\.bundle$/.test(name)
        ? limits["candidate.bundle"]
        : null;
  if (limit === null) throw new Error("Invalid runner result filename");
  const directory = openResults(options, executionId);
  let fd: number | undefined;
  try {
    fd = openResultFile(options, directory, name, limit);
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(65_536, limit + 1 - total));
      let filled = 0;
      while (filled < chunk.length) {
        const count = readSync(fd, chunk, filled, chunk.length - filled, null);
        if (count === 0) {
          chunks.push(chunk.subarray(0, filled));
          return Buffer.concat(chunks, total);
        }
        filled += count;
        total += count;
        if (total > limit) throw new Error("Runner result exceeds size limit");
      }
      chunks.push(chunk);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    closeSync(directory);
  }
}

function openResultFile(
  options: RunnerResults,
  directory: number,
  name: string,
  limit: number,
): number {
  const fd = openSync(
    `/proc/self/fd/${directory}/${name}`,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const info = fstatSync(fd);
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.uid !== options.agentUid ||
    info.gid !== options.resultsGid ||
    (info.mode & 0o7777) !== 0o640 ||
    info.size > limit
  ) {
    closeSync(fd);
    throw new Error("Unsafe runner result file");
  }
  return fd;
}

/** Up to `length` bytes of a large result file from `offset`, without reading the rest. */
export function readRunnerResultRange(
  options: RunnerResults,
  executionId: string,
  name: "session.ndjson.gz",
  offset: number,
  length: number,
  limit: number,
): Buffer {
  if (
    name !== "session.ndjson.gz" ||
    ![offset, length, limit].every(Number.isSafeInteger) ||
    offset < 0 ||
    length <= 0 ||
    offset > limit
  )
    throw new Error("Invalid runner result range");
  const directory = openResults(options, executionId);
  try {
    const fd = openResultFile(options, directory, name, limit);
    try {
      const bytes = Buffer.alloc(Math.min(length, limit - offset));
      let filled = 0;
      while (filled < bytes.length) {
        const count = readSync(fd, bytes, filled, bytes.length - filled, offset + filled);
        if (count === 0) break;
        filled += count;
      }
      return bytes.subarray(0, filled);
    } finally {
      closeSync(fd);
    }
  } finally {
    closeSync(directory);
  }
}
