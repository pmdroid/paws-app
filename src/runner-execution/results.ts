import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ExecutionIdSchema } from "./jobs";

export interface RunnerResults {
  root: string;
  agentUid: number;
  resultsGid: number;
}

function openResults(options: RunnerResults, executionId: string): number {
  ExecutionIdSchema.parse(executionId);
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
    const root = fstatSync(fd);
    if (root.uid !== 0 || root.gid !== options.resultsGid || (root.mode & 0o7777) !== 0o750)
      throw new Error("Unsafe runner results root");
    const directory = openSync(
      `/proc/self/fd/${fd}/${executionId}`,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    closeSync(fd);
    fd = directory;
    const job = fstatSync(fd);
    if (
      job.uid !== options.agentUid ||
      job.gid !== options.resultsGid ||
      (job.mode & 0o7777) !== 0o750
    )
      throw new Error("Unsafe runner results directory");
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function runnerResultDirectory(options: RunnerResults, executionId: string): string {
  const fd = openResults(options, executionId);
  closeSync(fd);
  return join(options.root, executionId);
}

export function readRunnerResultFile(
  options: RunnerResults,
  executionId: string,
  name: "candidate.bundle" | "events.jsonl" | "result.json",
): Buffer {
  const limits = {
    "candidate.bundle": 536_870_912,
    "events.jsonl": 16_777_216,
    "result.json": 1_048_576,
  };
  if (!Object.hasOwn(limits, name)) throw new Error("Invalid runner result filename");
  const directory = openResults(options, executionId);
  let fd: number | undefined;
  try {
    fd = openSync(
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
      info.size > limits[name]
    )
      throw new Error("Unsafe runner result file");
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(65_536, limits[name] + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) return Buffer.concat(chunks, total);
      total += count;
      if (total > limits[name]) throw new Error("Runner result exceeds size limit");
      chunks.push(chunk.subarray(0, count));
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    closeSync(directory);
  }
}
