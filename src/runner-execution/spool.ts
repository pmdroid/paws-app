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
  readdirSync,
  realpathSync,
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

function snapshotTree(
  directory: number,
  spool: RunnerSpool,
  stored: boolean,
  destination?: number,
): string {
  const hash = createHash("sha256");
  const repositoryRoot = realpathSync(`/proc/self/fd/${directory}`);
  const ancestors = new Set<string>();
  let total = 0;
  function openSource(fd: number, name: string): number {
    const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    const path = `/proc/self/fd/${fd}/${name}`;
    try {
      return openSync(path, flags);
    } catch (error) {
      if (stored || (error as NodeJS.ErrnoException).code !== "ELOOP") throw error;
      const target = realpathSync(path);
      if (
        !target.startsWith(`${repositoryRoot}/`) ||
        target
          .slice(repositoryRoot.length + 1)
          .split("/")
          .some((part) => part.toLowerCase() === ".git")
      )
        throw new Error("Task repository link escapes its source snapshot", { cause: error });
      const parts = target.slice(repositoryRoot.length + 1).split("/");
      let parent = openDirectory(`/proc/self/fd/${directory}/.`);
      try {
        for (const part of parts.slice(0, -1)) {
          const next = openDirectory(`/proc/self/fd/${parent}/${part}`);
          closeSync(parent);
          parent = next;
        }
        return openSync(`/proc/self/fd/${parent}/${parts.at(-1)}`, flags);
      } finally {
        closeSync(parent);
      }
    }
  }
  function visit(fd: number, target: number | undefined, prefix: string) {
    const info = fstatSync(fd);
    if (
      !info.isDirectory() ||
      info.uid !== spool.runnerUid ||
      (stored
        ? info.gid !== spool.agentGid || (info.mode & 0o7777) !== 0o750
        : (info.mode & 0o7022) !== 0)
    )
      throw new Error("Unsafe task repository directory");
    const identity = `${info.dev}:${info.ino}`;
    if (ancestors.has(identity)) throw new Error("Task repository contains a directory cycle");
    ancestors.add(identity);
    for (const name of readdirSync(`/proc/self/fd/${fd}`).sort()) {
      const relative = `${prefix}${name}`;
      total += 512 + Buffer.byteLength(name);
      if (name.toLowerCase() === ".git" || Buffer.byteLength(relative) > 4096)
        throw new Error("Unsafe task repository path");
      if (total > 536_870_912) throw new Error("Task repository exceeds size limit");
      const source = openSource(fd, name);
      let output: number | undefined;
      try {
        const stat = fstatSync(source);
        if (stat.isDirectory()) {
          hash.update(JSON.stringify([relative, "directory"]));
          if (target !== undefined) {
            const path = `/proc/self/fd/${target}/${name}`;
            mkdirSync(path, { mode: 0o750 });
            output = openDirectory(path);
            fchownSync(output, spool.runnerUid, spool.agentGid);
            fchmodSync(output, 0o750);
          }
          visit(source, output, `${relative}/`);
        } else {
          if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.uid !== spool.runnerUid ||
            (stored
              ? stat.gid !== spool.agentGid || (stat.mode & 0o7777) !== 0o640
              : (stat.mode & 0o7022) !== 0)
          )
            throw new Error("Unsafe task repository file");
          total += stat.size;
          if (total > 536_870_912) throw new Error("Task repository exceeds size limit");
          hash.update(JSON.stringify([relative, "file", stat.size]));
          if (target !== undefined) {
            output = openSync(
              `/proc/self/fd/${target}/${name}`,
              constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
              0o600,
            );
            fchownSync(output, spool.runnerUid, spool.agentGid);
            fchmodSync(output, 0o640);
          }
          const chunk = Buffer.alloc(65_536);
          let offset = 0;
          while (offset < stat.size) {
            const count = readSync(
              source,
              chunk,
              0,
              Math.min(chunk.length, stat.size - offset),
              offset,
            );
            if (count === 0) throw new Error("Task repository file changed");
            hash.update(chunk.subarray(0, count));
            if (output !== undefined) {
              let written = 0;
              while (written < count) written += writeSync(output, chunk, written, count - written);
            }
            offset += count;
          }
          const after = fstatSync(source);
          if (
            after.size !== stat.size ||
            after.mtimeMs !== stat.mtimeMs ||
            after.ctimeMs !== stat.ctimeMs
          )
            throw new Error("Task repository file changed");
        }
        if (output !== undefined) fsyncSync(output);
      } finally {
        closeSync(source);
        if (output !== undefined) closeSync(output);
      }
    }
    ancestors.delete(identity);
  }
  visit(directory, destination, "");
  return hash.digest("hex");
}

function taskRepository(directory: number, spool: RunnerSpool): string {
  const fd = openDirectory(`/proc/self/fd/${directory}/repository`);
  try {
    return snapshotTree(fd, spool, true);
  } finally {
    closeSync(fd);
  }
}

export type RunnerJobInputs = {
  inputFiles: { path: string; mimeType: string; bytes: Uint8Array }[];
  prompt?: string;
};
function inputDescriptors(job: RunnerJob) {
  return job.command.type === "run" || job.command.type === "review" || job.command.type === "task"
    ? { files: job.command.inputFiles ?? [], context: job.command.promptContext }
    : { files: [], context: undefined };
}
function inputHash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
function readInputContents(directory: number, spool: RunnerSpool, job: RunnerJob): RunnerJobInputs {
  function read(name: string, descriptor: { sizeBytes: number; sha256: string }) {
    const fd = openSync(
      `/proc/self/fd/${directory}/${name}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = fstatSync(fd);
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.uid !== spool.runnerUid ||
        info.gid !== spool.agentGid ||
        (info.mode & 0o7777) !== 0o640 ||
        info.size !== descriptor.sizeBytes
      )
        throw new Error("Unsafe runner input contents");
      const bytes = readBounded(fd, descriptor.sizeBytes);
      if (bytes.length !== descriptor.sizeBytes || inputHash(bytes) !== descriptor.sha256)
        throw new Error("Runner input content integrity failed");
      return bytes;
    } finally {
      closeSync(fd);
    }
  }
  const { files, context } = inputDescriptors(job);
  const inputFiles = files.map((file) => ({
    path: file.path,
    mimeType: file.mimeType,
    bytes: read(`input-${file.id}.bytes`, file),
  }));
  let prompt = "prompt" in job.command ? job.command.prompt : undefined;
  if (context) {
    const bytes = read("prompt.bytes", context);
    prompt = bytes.toString("utf8");
    if (!Buffer.from(prompt, "utf8").equals(bytes))
      throw new Error("Runner prompt context is not UTF-8");
  }
  return { inputFiles, ...(prompt === undefined ? {} : { prompt }) };
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
    if (job.command.type === "task" && job.command.repository) taskRepository(fd, spool);
    readInputContents(fd, spool, job);
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

export function readRunnerJobInputs(spool: RunnerSpool, executionId: string): RunnerJobInputs {
  ExecutionIdSchema.parse(executionId);
  const root = openRoot(spool);
  let directory: number | undefined;
  try {
    directory = openDirectory(`/proc/self/fd/${root}/${executionId}`);
    validateDirectory(directory, spool);
    const job = readJob(directory, spool, executionId);
    return readInputContents(directory, spool, job);
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

export function runnerTaskRepositoryPath(spool: RunnerSpool, executionId: string): string {
  const job = readRunnerJob(spool, executionId);
  if (job.command.type !== "task" || !job.command.repository)
    throw new Error("Job has no task repository");
  return join(spool.root, executionId, "repository");
}

export function runnerJobDirectory(spool: RunnerSpool, executionId: string): string {
  readRunnerJob(spool, executionId);
  return join(spool.root, executionId);
}

export function publishRunnerJob(
  spool: RunnerSpool,
  input: RunnerJob,
  options: {
    repositoryBundle?: string;
    repositorySnapshot?: string;
    inputFiles?: readonly Uint8Array[];
    promptContext?: Uint8Array;
  } = {},
): RunnerJob {
  const job = RunnerJobSchema.parse(input);
  const descriptors = inputDescriptors(job);
  const inputFiles = (options.inputFiles ?? []).map((bytes) => Buffer.from(bytes));
  const promptContext =
    options.promptContext === undefined ? undefined : Buffer.from(options.promptContext);
  if (
    inputFiles.length !== descriptors.files.length ||
    inputFiles.some(
      (bytes, index) =>
        bytes.length !== descriptors.files[index]!.sizeBytes ||
        inputHash(bytes) !== descriptors.files[index]!.sha256,
    )
  )
    throw new Error("Runner input files must match signed job");
  if (
    Boolean(descriptors.context) !== (promptContext !== undefined) ||
    (descriptors.context &&
      promptContext &&
      (promptContext.length !== descriptors.context.sizeBytes ||
        inputHash(promptContext) !== descriptors.context.sha256 ||
        !Buffer.from(promptContext.toString("utf8"), "utf8").equals(promptContext)))
  )
    throw new Error("Runner prompt context must match signed job");
  const needsBundle = job.command.type === "run" || job.command.type === "review";
  if (needsBundle !== (options.repositoryBundle !== undefined))
    throw new Error("Repository bundle must match job type");
  const needsSnapshot = job.command.type === "task" && job.command.repository !== undefined;
  if (needsSnapshot !== (options.repositorySnapshot !== undefined))
    throw new Error("Repository snapshot must match task context");
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
        if (options.repositorySnapshot !== undefined) {
          const source = openAbsoluteDirectory(options.repositorySnapshot);
          try {
            if (snapshotTree(source, spool, false) !== taskRepository(existingDirectory, spool))
              throw new Error("Task repository already exists with different content");
          } finally {
            closeSync(source);
          }
        }
        return existing;
      } finally {
        closeSync(existingDirectory);
      }
    }
    staging = `/proc/self/fd/${root}/.${job.executionId}.${randomUUID()}`;
    mkdirSync(staging, { mode: 0o700 });
    directory = openDirectory(staging);
    fchownSync(directory, spool.runnerUid, spool.agentGid);
    fchmodSync(directory, 0o700);
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
    if (options.repositorySnapshot !== undefined) {
      const source = openAbsoluteDirectory(options.repositorySnapshot);
      let target: number | undefined;
      try {
        const snapshotPath = `/proc/self/fd/${directory}/repository`;
        mkdirSync(snapshotPath, { mode: 0o750 });
        target = openDirectory(snapshotPath);
        fchownSync(target, spool.runnerUid, spool.agentGid);
        fchmodSync(target, 0o750);
        snapshotTree(source, spool, false, target);
        fsyncSync(target);
      } finally {
        closeSync(source);
        if (target !== undefined) closeSync(target);
      }
    }
    const blobs = inputFiles.map((bytes, id) => ({ name: `input-${id}.bytes`, bytes }));
    if (promptContext !== undefined) blobs.push({ name: "prompt.bytes", bytes: promptContext });
    for (const blob of blobs) {
      const fd = openSync(
        `/proc/self/fd/${directory}/${blob.name}`,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        fchownSync(fd, spool.runnerUid, spool.agentGid);
        fchmodSync(fd, 0o640);
        writeFileSync(fd, blob.bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
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
    fchmodSync(directory, 0o750);
    validateDirectory(directory, spool);
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
