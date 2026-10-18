import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { CommandRunRequest, CommandRunResult, CommandRunner } from "../types";
import { credentialSecrets, scrubCommandEnv } from "./env";
import type { CloseoutOutputStream } from "./progress";
import { createStreamScrubber, scrubText } from "./scrub";

/** Combined stdout and stderr are capped per stream. Past this, `truncated` is set. */
const OUTPUT_CAP_BYTES = 256 * 1024;

const GIT_TIMEOUT_SECONDS = 30;

export type CommandRunnerOptions = {
  /** Parent environment. Credentials are removed before the child starts. */
  env?: NodeJS.ProcessEnv;
  /**
   * Candidate commit the worktree was checked out at.
   * When omitted, `run` compares `HEAD` before the process with `HEAD` after it.
   */
  expectedHead?: string;
  /** Directory for logs created by {@link CommandRunner.run}. */
  logDir?: string;
  /** `~/.paws` override used when `logDir` is omitted. */
  home?: string;
};

/** Extra fields the orchestrator sets so the log lands in the evidence directory. */
export type LoggedCommandRequest = CommandRunRequest & {
  logFile: string;
  artifactPath: string;
  expectedHead: string;
  onOutput?: (stream: CloseoutOutputStream, text: string, truncated: boolean) => void;
  /** Variables added for this command only, such as `CLOSEOUT_MEDIA_DIR`. */
  extraEnv?: Record<string, string>;
};

export type PawsCommandRunner = CommandRunner & {
  runLogged(request: LoggedCommandRequest): Promise<CommandRunResult>;
};

type GitResult = {
  ok: boolean;
  stdout: Buffer;
  stderr: string;
  truncated: boolean;
};

export function createCommandRunner(options: CommandRunnerOptions = {}): PawsCommandRunner {
  return {
    run(request) {
      const dir = options.logDir ?? join(pawsHome(options.home), "closeout", "tmp", "logs");
      const file = join(
        dir,
        `cmd-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.log`,
      );
      return executeCommand({
        cwd: request.cwd,
        argv: request.argv,
        timeoutSeconds: request.timeoutSeconds,
        env: options.env,
        expectedHead: options.expectedHead,
        logFile: file,
        artifactPath: file,
      });
    },
    runLogged(request) {
      return executeCommand({
        cwd: request.cwd,
        argv: request.argv,
        timeoutSeconds: request.timeoutSeconds,
        env: request.extraEnv
          ? { ...(options.env ?? process.env), ...request.extraEnv }
          : options.env,
        expectedHead: request.expectedHead,
        logFile: request.logFile,
        artifactPath: request.artifactPath,
        ...(request.onOutput ? { onOutput: request.onOutput } : {}),
      });
    },
  };
}

export async function executeCommand(input: {
  cwd: string;
  argv: string[];
  timeoutSeconds: number;
  env?: NodeJS.ProcessEnv;
  expectedHead?: string;
  logFile: string;
  artifactPath: string;
  onOutput?: (stream: CloseoutOutputStream, text: string, truncated: boolean) => void;
}): Promise<CommandRunResult> {
  const secrets = credentialSecrets(input.env);
  const env = scrubCommandEnv(input.env);
  const before = await porcelain(input.cwd, env);
  const expected = input.expectedHead ?? (await readHead(input.cwd, env)) ?? "";
  const started = Date.now();
  const spawned = await spawnArgv(input.argv, input.cwd, env, input.timeoutSeconds, {
    secrets,
    ...(input.onOutput ? { onText: input.onOutput } : {}),
  });
  const durationMs = Math.max(0, Date.now() - started);
  const after = await porcelain(input.cwd, env);
  const head = await readHead(input.cwd, env);
  const log = scrubText(`STDOUT\n${spawned.stdout}\nSTDERR\n${spawned.stderr}`, secrets);
  const bytes = Buffer.from(log, "utf8");
  mkdirSync(dirname(input.logFile), { recursive: true });
  writeFileSync(input.logFile, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    argv: input.argv,
    exitCode: spawned.exitCode,
    timedOut: spawned.timedOut,
    dirty: newDirt(before, after),
    headMoved: head === null || head !== expected.toLowerCase(),
    durationMs,
    truncated: spawned.truncated,
    artifacts: [{ path: input.artifactPath, sha256 }],
  };
}

/**
 * `git status --porcelain=v1 -z` before and after. New dirt is a non-empty
 * status that differs from the status before the process. An unreadable
 * status after the process counts as dirt.
 */
function newDirt(before: Buffer | null, after: Buffer | null): boolean {
  if (after === null) return true;
  if (after.length === 0) return false;
  if (before === null) return true;
  return !before.equals(after);
}

export async function git(
  cwd: string,
  args: string[],
  env: Record<string, string>,
): Promise<GitResult> {
  const spawned = await spawnArgv(
    ["git", ...args],
    cwd,
    { ...env, GIT_TERMINAL_PROMPT: "0" },
    GIT_TIMEOUT_SECONDS,
  );
  return {
    ok: spawned.started && !spawned.timedOut && spawned.exitCode === 0 && !spawned.truncated,
    stdout: spawned.stdoutBytes,
    stderr: spawned.stderr,
    truncated: spawned.truncated,
  };
}

export async function readHead(cwd: string, env: Record<string, string>): Promise<string | null> {
  const result = await git(cwd, ["rev-parse", "HEAD"], env);
  if (!result.ok) return null;
  const sha = result.stdout.toString("utf8").trim().toLowerCase();
  return isSha(sha) ? sha : null;
}

export async function resolveCommit(
  cwd: string,
  rev: string,
  env: Record<string, string>,
): Promise<string | null> {
  const result = await git(
    cwd,
    ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`],
    env,
  );
  if (!result.ok) return null;
  const sha = result.stdout.toString("utf8").trim().toLowerCase();
  return isSha(sha) ? sha : null;
}

export async function changedPaths(
  cwd: string,
  base: string,
  head: string,
  env: Record<string, string>,
): Promise<{ ok: true; paths: string[] } | { ok: false; message: string }> {
  const result = await git(
    cwd,
    ["diff", "--name-only", "--no-renames", "-z", base, head, "--"],
    env,
  );
  if (!result.ok) return { ok: false, message: pathsUnavailable(result.stderr) };
  const text = decodeUtf8(result.stdout);
  if (text === null) return { ok: false, message: "changed paths are unavailable" };
  return { ok: true, paths: text.split("\0").filter((path) => path.length > 0) };
}

export function pawsHome(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const fromEnv = process.env.PAWS_HOME;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".paws");
}

export function isSha(value: string): boolean {
  return (value.length === 40 || value.length === 64) && /^[0-9a-f]+$/.test(value);
}

async function porcelain(cwd: string, env: Record<string, string>): Promise<Buffer | null> {
  const result = await git(cwd, ["status", "--porcelain=v1", "-z"], env);
  if (!result.ok) return null;
  return result.stdout;
}

function pathsUnavailable(stderr: string): string {
  const line = stderr
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (line === undefined || line.length === 0) return "changed paths are unavailable";
  return `changed paths are unavailable: ${line}`;
}

function decodeUtf8(bytes: Buffer): string | null {
  const text = bytes.toString("utf8");
  if (!bytes.equals(Buffer.from(text, "utf8"))) return null;
  return text;
}

type Spawned = {
  started: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutBytes: Buffer;
  truncated: boolean;
};

/**
 * Argv execution with no shell. `timeoutSeconds` kills the child's process
 * group, so grandchildren started by the command die with it.
 */
type StreamTap = {
  secrets: readonly string[];
  onText?: (stream: CloseoutOutputStream, text: string, truncated: boolean) => void;
};

function spawnArgv(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutSeconds: number,
  tap?: StreamTap,
): Promise<Spawned> {
  const program = argv[0];
  if (program === undefined || program.length === 0) {
    return Promise.resolve(notStarted("command argv is empty"));
  }
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(program, argv.slice(1), {
        cwd,
        env,
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve(notStarted(errorText(error)));
      return;
    }

    let settled = false;
    let timedOut = false;
    const stdout = tap
      ? collectText(child.stdout, OUTPUT_CAP_BYTES, tap.secrets, (text, truncated) => {
          tap.onText?.("stdout", text, truncated);
        })
      : collect(child.stdout, OUTPUT_CAP_BYTES);
    const stderr = tap
      ? collectText(child.stderr, OUTPUT_CAP_BYTES, tap.secrets, (text, truncated) => {
          tap.onText?.("stderr", text, truncated);
        })
      : collect(child.stderr, OUTPUT_CAP_BYTES);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, timeoutSeconds * 1000);

    const finish = (result: Spawned) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.once("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "ENOTDIR") {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(notStarted(errorText(error)));
      }
    });

    child.once("exit", (code) => {
      void Promise.all([stdout, stderr]).then(([out, err]) => {
        finish({
          started: true,
          exitCode: timedOut ? null : code,
          timedOut,
          stdout: out.text,
          stderr: err.text,
          stdoutBytes: out.bytes,
          truncated: out.truncated || err.truncated,
        });
      });
    });
  });
}

function notStarted(stderr: string): Spawned {
  return {
    started: false,
    exitCode: null,
    timedOut: false,
    stdout: "",
    stderr,
    stdoutBytes: Buffer.alloc(0),
    truncated: false,
  };
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process already exited.
    }
  }
}

function collectText(
  stream: NodeJS.ReadableStream | null,
  cap: number,
  secrets: readonly string[],
  onText: (text: string, truncated: boolean) => void,
): Promise<{ text: string; bytes: Buffer; truncated: boolean }> {
  return new Promise((resolve) => {
    if (stream === null) {
      resolve({ text: "", bytes: Buffer.alloc(0), truncated: false });
      return;
    }
    const decoder = new StringDecoder("utf8");
    const scrubber = createStreamScrubber(secrets);
    let text = "";
    let truncated = false;
    let settled = false;
    const emit = (chunk: string) => {
      if (chunk.length === 0 || truncated) return;
      const room = cap - Buffer.byteLength(text);
      if (room <= 0) {
        truncated = true;
        onText("", true);
        return;
      }
      let piece = chunk;
      if (Buffer.byteLength(piece) > room) {
        piece = clipUtf8(piece, room);
        truncated = true;
      }
      if (piece.length === 0) {
        truncated = true;
        onText("", true);
        return;
      }
      text += piece;
      onText(piece, truncated);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      emit(scrubber.push(decoder.end()));
      emit(scrubber.flush());
      const bytes = Buffer.from(text);
      resolve({ text, bytes, truncated });
    };
    stream.on("data", (chunk: Buffer | string) => {
      if (truncated) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      emit(scrubber.push(decoder.write(buf)));
    });
    stream.on("end", done);
    stream.on("error", done);
    stream.on("close", done);
  });
}

function clipUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0) {
    const byte = bytes.at(end);
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
}

function collect(
  stream: NodeJS.ReadableStream | null,
  cap: number,
): Promise<{ text: string; bytes: Buffer; truncated: boolean }> {
  return new Promise((resolve) => {
    if (stream === null) {
      resolve({ text: "", bytes: Buffer.alloc(0), truncated: false });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      const bytes = Buffer.concat(chunks);
      resolve({ text: bytes.toString("utf8"), bytes, truncated });
    };
    stream.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (truncated) return;
      if (size + buf.length > cap) {
        const room = cap - size;
        if (room > 0) chunks.push(buf.subarray(0, room));
        size = cap;
        truncated = true;
        return;
      }
      chunks.push(buf);
      size += buf.length;
    });
    stream.on("end", done);
    stream.on("error", done);
    stream.on("close", done);
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
