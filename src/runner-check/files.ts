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
import { ExecutionIdSchema } from "../runner-execution";
import {
  RunnerCheckAttemptSchema,
  RunnerCheckInputSchema,
  RunnerCheckRequestSchema,
  RunnerCheckResultSchema,
  type RunnerCheckAttempt,
  type RunnerCheckInput,
  type RunnerCheckRequest,
  type RunnerCheckPaths,
  type RunnerCheckResult,
} from "./schema";

const INPUT_LIMIT = 262_144;
const BUNDLE_LIMIT = 536_870_912;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function hash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function runnerCheckInputHash(input: RunnerCheckInput): string {
  return hash(canonical(boundedInput(input)));
}

function boundedInput(value: RunnerCheckInput): RunnerCheckInput {
  const input = RunnerCheckInputSchema.parse(value);
  if (Buffer.byteLength(canonical(input)) > INPUT_LIMIT)
    throw new Error("Runner check input exceeds size limit");
  return input;
}

export function deriveRunnerCheckInput(value: RunnerCheckRequest): RunnerCheckInput {
  const request = RunnerCheckRequestSchema.parse(value);
  if (
    request.cwd !== "." &&
    (isAbsolute(request.cwd) ||
      request.cwd.split("/").some((part) => !part || part === "." || part === ".."))
  )
    throw new Error("Check working directory must be canonical and relative");
  const attempt = `/var/lib/paws-check-attempts/${request.verificationAttemptId}`;
  return boundedInput({
    ...request,
    format: 1,
    cwd: request.cwd === "." ? `${attempt}/workspace` : `${attempt}/workspace/${request.cwd}`,
    env: {
      HOME: `${attempt}/home`,
      TMPDIR: `${attempt}/tmp`,
      PATH: "/opt/paws-runner/bin:/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      CI: "1",
    },
  });
}

function validatePaths(paths: RunnerCheckPaths): void {
  if (
    process.platform !== "linux" ||
    [paths.inputRoot, paths.workRoot, paths.resultRoot].some(
      (path) => !isAbsolute(path) || path.split("/").some((part) => part === "." || part === ".."),
    ) ||
    [paths.runnerUid, paths.runnerGid, paths.inputGid, paths.checkUid, paths.checkGid].some(
      (value) => !Number.isSafeInteger(value) || value <= 0,
    ) ||
    paths.runnerUid === paths.checkUid ||
    paths.inputGid === paths.checkGid ||
    paths.runnerGid === paths.checkGid
  )
    throw new Error("Invalid runner check configuration");
}

function openDirectory(path: string): number {
  return openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

function openAbsoluteDirectory(path: string): number {
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

function validateDirectory(fd: number, uid: number, gid: number, setgid = false): void {
  const info = fstatSync(fd);
  if (
    !info.isDirectory() ||
    info.uid !== uid ||
    info.gid !== gid ||
    !((info.mode & 0o7777) === 0o750 || (setgid && (info.mode & 0o7777) === 0o2750))
  )
    throw new Error("Unsafe runner check directory");
}

function openInputContainer(paths: RunnerCheckPaths, name: "attempts" | "commands"): number {
  validatePaths(paths);
  const root = openAbsoluteDirectory(paths.inputRoot);
  let container: number | undefined;
  try {
    validateDirectory(root, paths.runnerUid, paths.inputGid, true);
    container = openDirectory(`/proc/self/fd/${root}/${name}`);
    validateDirectory(container, paths.runnerUid, paths.inputGid, true);
    return container;
  } catch (error) {
    if (container !== undefined) closeSync(container);
    throw error;
  } finally {
    closeSync(root);
  }
}

function readFile(
  directory: number,
  name: string,
  uid: number,
  gid: number,
  limit: number,
): Buffer {
  const file = openSync(
    `/proc/self/fd/${directory}/${name}`,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = fstatSync(file);
    if (
      !info.isFile() ||
      info.uid !== uid ||
      info.gid !== gid ||
      info.nlink !== 1 ||
      (info.mode & 0o7777) !== 0o640 ||
      info.size > limit
    )
      throw new Error("Unsafe runner check file");
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(65_536, limit - total + 1));
      const count = readSync(file, chunk, 0, chunk.length, total);
      if (count === 0) return Buffer.concat(chunks, total);
      total += count;
      if (total > limit) throw new Error("Runner check file exceeds size limit");
      chunks.push(chunk.subarray(0, count));
    }
  } finally {
    closeSync(file);
  }
}

function openInput(
  paths: RunnerCheckPaths,
  container: "attempts" | "commands",
  id: string,
): number {
  ExecutionIdSchema.parse(id);
  const root = openInputContainer(paths, container);
  let directory: number | undefined;
  try {
    directory = openDirectory(`/proc/self/fd/${root}/${id}`);
    validateDirectory(directory, paths.runnerUid, paths.inputGid);
    return directory;
  } catch (error) {
    if (directory !== undefined) closeSync(directory);
    throw error;
  } finally {
    closeSync(root);
  }
}

function readJson(directory: number, name: string, paths: RunnerCheckPaths): unknown {
  return JSON.parse(
    readFile(directory, name, paths.runnerUid, paths.inputGid, INPUT_LIMIT).toString("utf8"),
  );
}

function openBundle(path: string, paths: RunnerCheckPaths): number {
  if (
    !isAbsolute(path) ||
    path.endsWith("/") ||
    path.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error("Invalid runner check bundle path");
  const parent = openAbsoluteDirectory(dirname(path));
  let file: number;
  try {
    file = openSync(
      `/proc/self/fd/${parent}/${basename(path)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } finally {
    closeSync(parent);
  }
  const info = fstatSync(file);
  if (
    !info.isFile() ||
    info.uid !== paths.runnerUid ||
    info.nlink !== 1 ||
    (info.mode & 0o7027) !== 0 ||
    info.size <= 0 ||
    info.size > BUNDLE_LIMIT
  ) {
    closeSync(file);
    throw new Error("Unsafe runner check bundle");
  }
  return file;
}

function bundleDigest(file: number, destination?: number): string {
  const digest = createHash("sha256");
  const chunk = Buffer.alloc(65_536);
  let total = 0;
  while (true) {
    const count = readSync(file, chunk, 0, chunk.length, total);
    if (count === 0) {
      if (total === 0) throw new Error("Empty runner check bundle");
      return digest.digest("hex");
    }
    total += count;
    if (total > BUNDLE_LIMIT) throw new Error("Runner check bundle exceeds size limit");
    digest.update(chunk.subarray(0, count));
    if (destination !== undefined) {
      let written = 0;
      while (written < count) written += writeSync(destination, chunk, written, count - written);
    }
  }
}

function writeInput(
  directory: number,
  name: string,
  content: string,
  paths: RunnerCheckPaths,
): void {
  if (Buffer.byteLength(content) > INPUT_LIMIT)
    throw new Error("Runner check input exceeds size limit");
  const file = openSync(
    `/proc/self/fd/${directory}/${name}`,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchownSync(file, paths.runnerUid, paths.inputGid);
    fchmodSync(file, 0o640);
    writeFileSync(file, content);
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
}

function publish(
  paths: RunnerCheckPaths,
  container: "attempts" | "commands",
  id: string,
  name: string,
  content: string,
  bundle?: number,
): void {
  if (process.getuid?.() !== paths.runnerUid)
    throw new Error("Only the runner may publish check inputs");
  const root = openInputContainer(paths, container);
  let directory: number | undefined;
  let staging: string | undefined;
  try {
    const destination = `/proc/self/fd/${root}/${id}`;
    try {
      directory = openDirectory(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (directory !== undefined) {
      validateDirectory(directory, paths.runnerUid, paths.inputGid);
      if (canonical(readJson(directory, name, paths)) !== content)
        throw new Error("Runner check input already exists");
      if (bundle !== undefined) {
        const stored = openSync(
          `/proc/self/fd/${directory}/repository.bundle`,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const info = fstatSync(stored);
          if (
            !info.isFile() ||
            info.uid !== paths.runnerUid ||
            info.gid !== paths.inputGid ||
            info.nlink !== 1 ||
            (info.mode & 0o7777) !== 0o640 ||
            info.size <= 0 ||
            info.size > BUNDLE_LIMIT ||
            bundleDigest(stored) !== bundleDigest(bundle)
          )
            throw new Error("Runner check bundle already exists with different content");
        } finally {
          closeSync(stored);
        }
      }
      return;
    }
    staging = `/proc/self/fd/${root}/.${id}.${randomUUID()}`;
    mkdirSync(staging, { mode: 0o700 });
    directory = openDirectory(staging);
    fchownSync(directory, paths.runnerUid, paths.inputGid);
    fchmodSync(directory, 0o750);
    if (bundle !== undefined) {
      const file = openSync(
        `/proc/self/fd/${directory}/repository.bundle`,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        fchownSync(file, paths.runnerUid, paths.inputGid);
        fchmodSync(file, 0o640);
        if (
          bundleDigest(bundle, file) !==
          RunnerCheckAttemptSchema.parse(JSON.parse(content)).bundleSha256
        )
          throw new Error("Runner check bundle changed during publication");
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
    }
    writeInput(directory, name, content, paths);
    fsyncSync(directory);
    renameSync(staging, destination);
    staging = undefined;
    fsyncSync(root);
  } finally {
    if (directory !== undefined) closeSync(directory);
    if (staging !== undefined) rmSync(staging, { recursive: true, force: true });
    closeSync(root);
  }
}

export function runnerCheckWorkspace(
  paths: RunnerCheckPaths,
  verificationAttemptId: string,
): string {
  validatePaths(paths);
  ExecutionIdSchema.parse(verificationAttemptId);
  return join(paths.workRoot, verificationAttemptId, "workspace");
}

function parseInput(paths: RunnerCheckPaths, value: RunnerCheckInput): RunnerCheckInput {
  const input = boundedInput(value);
  const workspace = runnerCheckWorkspace(paths, input.verificationAttemptId);
  if (
    !(input.cwd === workspace || input.cwd.startsWith(`${workspace}/`)) ||
    input.cwd.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error("Check working directory must stay in its attempt workspace");
  return input;
}

export function publishRunnerCheckAttempt(
  paths: RunnerCheckPaths,
  input: Pick<RunnerCheckAttempt, "verificationAttemptId" | "candidateSha" | "checkoutExclusions">,
  options: { repositoryBundle: string },
): RunnerCheckAttempt {
  validatePaths(paths);
  if (process.getuid?.() !== paths.runnerUid)
    throw new Error("Only the runner may publish check inputs");
  const bundle = openBundle(options.repositoryBundle, paths);
  try {
    const attempt = RunnerCheckAttemptSchema.parse({
      format: 1,
      ...input,
      bundleSha256: bundleDigest(bundle),
    });
    publish(
      paths,
      "attempts",
      attempt.verificationAttemptId,
      "attempt.json",
      canonical(attempt),
      bundle,
    );
    return attempt;
  } finally {
    closeSync(bundle);
  }
}

export function publishRunnerCheckCommand(
  paths: RunnerCheckPaths,
  value: RunnerCheckInput,
): RunnerCheckInput {
  const input = parseInput(paths, value);
  const directory = openInput(paths, "attempts", input.verificationAttemptId);
  try {
    const attempt = RunnerCheckAttemptSchema.parse(readJson(directory, "attempt.json", paths));
    if (
      attempt.verificationAttemptId !== input.verificationAttemptId ||
      attempt.candidateSha !== input.candidateSha ||
      JSON.stringify(attempt.checkoutExclusions ?? []) !==
        JSON.stringify(input.checkoutExclusions ?? [])
    )
      throw new Error("Runner check candidate mismatch");
  } finally {
    closeSync(directory);
  }
  publish(paths, "commands", input.executionId, "job.json", canonical(input));
  return input;
}

export function readRunnerCheckResult(
  paths: RunnerCheckPaths,
  value: RunnerCheckInput,
): RunnerCheckResult | null {
  const input = parseInput(paths, value);
  const command = openInput(paths, "commands", input.executionId);
  try {
    if (canonical(readJson(command, "job.json", paths)) !== canonical(input))
      throw new Error("Runner check input identity mismatch");
  } finally {
    closeSync(command);
  }
  const root = openAbsoluteDirectory(paths.resultRoot);
  let directory: number | undefined;
  try {
    validateDirectory(root, 0, paths.runnerGid);
    try {
      directory = openDirectory(`/proc/self/fd/${root}/${input.executionId}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    validateDirectory(directory, 0, paths.runnerGid);
    let content: Buffer;
    try {
      content = readFile(directory, "result.json", 0, paths.runnerGid, 13_000_000);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const result = RunnerCheckResultSchema.parse(JSON.parse(content.toString("utf8")));
    if (
      result.executionId !== input.executionId ||
      result.verificationAttemptId !== input.verificationAttemptId ||
      result.candidateSha !== input.candidateSha ||
      result.inputSha256 !== runnerCheckInputHash(input)
    )
      throw new Error("Runner check result identity mismatch");
    return result;
  } finally {
    if (directory !== undefined) closeSync(directory);
    closeSync(root);
  }
}
