import { journalCaught } from "../journal";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

import { LockWaitTimeoutError, withFileLock } from "./lock";

/** The mise binary the runner package ships. */
/**
 * The runner package's own executables: its Bun, mise, and the provider launchers. Paws starts
 * them by absolute path. Tasks never get this folder on `PATH`, so a repo's Bun comes from mise.
 */
export const RUNNER_BIN_DIR = "/opt/paws-runner/bin";
export const RUNNER_MISE_PATH = `${RUNNER_BIN_DIR}/mise`;

/** Longest a task's runtime install may run, and longest it waits for another task's lock. */
export const RUNTIME_INSTALL_TIMEOUT_MS = 10 * 60_000;

/** One runtime to install, such as `{ tool: "node", version: "22" }`. */
export type InstallRuntime = { tool: string; version: string };

/** Where mise keeps installs and downloads, shared by every task on the runner. */
export function runnerMiseDirectories(home: string): { dataDir: string; cacheDir: string } {
  return {
    dataDir: join(home, ".local", "share", "mise"),
    cacheDir: join(home, ".cache", "mise"),
  };
}

export type RuntimeInstallResult =
  | {
      ok: true;
      durationMs: number;
      installed: InstallRuntime[];
      /** Each installed runtime's pinned bin dir, in `runtimes` order, from `mise where`. */
      binPaths: string[];
    }
  | { ok: false; durationMs: number; runtime: InstallRuntime; message: string };

export interface InstallRuntimesOptions {
  runtimes: readonly InstallRuntime[];
  /** The agent's home. Installs go under `<home>/.local/share/mise`. */
  home: string;
  mise?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** A line for the journal and the issue page, such as the wait for another task's install. */
  notice?: (text: string) => void;
}

const OUTPUT_TAIL = 4_096;

/**
 * Install `runtimes` with the runner's mise before the agent starts.
 *
 * mise reads no repository or global config: it runs in a scratch directory with a scratch
 * `MISE_CONFIG_DIR`, no trusted config paths, and a ceiling at that directory. A `flock` on
 * the data dir serializes installs across tasks, and mise skips versions it already has, so a
 * version is installed once per runner and reused. Each runtime is its own `mise install` so a
 * failure names the runtime that broke. After each install, `mise where` gives the version's
 * install dir, and its `bin` goes in `binPaths` so tasks run pinned binaries instead of shims.
 */
export async function installRuntimes(
  options: InstallRuntimesOptions,
): Promise<RuntimeInstallResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? RUNTIME_INSTALL_TIMEOUT_MS;
  const first = options.runtimes[0];
  if (!first) return { ok: true, durationMs: 0, installed: [], binPaths: [] };
  const { dataDir, cacheDir } = runnerMiseDirectories(options.home);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  try {
    return await withFileLock(
      join(dataDir, ".paws-install.lock"),
      {
        waitMs: timeoutMs,
        signal: options.signal,
        onWait: () =>
          options.notice?.(
            "Waiting for another task on this runner to finish installing runtimes.",
          ),
      },
      () => installLocked(options, { dataDir, cacheDir, timeoutMs, started }),
    );
  } catch (error) {
    if (!(error instanceof LockWaitTimeoutError)) throw error;
    journalCaught(error, "install.installRuntimes.withFileLock", null);
    return {
      ok: false,
      durationMs: Date.now() - started,
      runtime: first,
      message: `Paws could not install the runtime ${label(first)}: another task's install held the runner's mise lock for more than ${duration(timeoutMs)}.`,
    };
  }
}

async function installLocked(
  options: InstallRuntimesOptions,
  context: { dataDir: string; cacheDir: string; timeoutMs: number; started: number },
): Promise<RuntimeInstallResult> {
  const scratch = mkdtempSync(join(tmpdir(), "paws-mise-"));
  try {
    const configDir = join(scratch, "config");
    mkdirSync(configDir, { mode: 0o700 });
    const env: Record<string, string> = {
      PATH: "/opt/paws-runner/bin:/usr/local/bin:/usr/bin:/bin",
      HOME: options.home,
      TMPDIR: scratch,
      MISE_DATA_DIR: context.dataDir,
      MISE_CACHE_DIR: context.cacheDir,
      MISE_CONFIG_DIR: configDir,
      MISE_GLOBAL_CONFIG_FILE: join(configDir, "config.toml"),
      MISE_SYSTEM_CONFIG_FILE: join(configDir, "system.toml"),
      MISE_TRUSTED_CONFIG_PATHS: "",
      MISE_CEILING_PATHS: scratch,
      MISE_YES: "1",
      MISE_COLOR: "0",
    };
    const installStarted = Date.now();
    const deadline = installStarted + context.timeoutMs;
    const installed: InstallRuntime[] = [];
    const binPaths: string[] = [];
    const mise = (args: string[]) =>
      runMise(options.mise ?? RUNNER_MISE_PATH, args, {
        env,
        cwd: scratch,
        timeoutMs: Math.max(0, deadline - Date.now()),
        signal: options.signal,
      });
    for (const runtime of options.runtimes) {
      options.signal?.throwIfAborted();
      const outcome = await mise(["install", label(runtime)]);
      if (outcome.kind !== "ok")
        return {
          ok: false,
          durationMs: Date.now() - context.started,
          runtime,
          message:
            outcome.kind === "timeout"
              ? `Paws stopped installing the runtime ${label(runtime)}: the install ran for more than ${duration(context.timeoutMs)}.`
              : `Paws could not install the runtime ${label(runtime)}: ${outcome.detail}`,
        };
      const where = await mise(["where", label(runtime)]);
      const dir = where.kind === "ok" ? where.stdout.trim() : "";
      if (where.kind !== "ok" || !isAbsolute(dir) || dir.includes("\n") || dir.includes(delimiter))
        return {
          ok: false,
          durationMs: Date.now() - context.started,
          runtime,
          message:
            where.kind === "timeout"
              ? `Paws stopped installing the runtime ${label(runtime)}: the install ran for more than ${duration(context.timeoutMs)}.`
              : `Paws could not find the installed runtime ${label(runtime)}: ${
                  where.kind === "failed" ? where.detail : "mise where printed no usable path."
                }`,
        };
      installed.push(runtime);
      binPaths.push(join(dir, "bin"));
    }
    return { ok: true, durationMs: Date.now() - context.started, installed, binPaths };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

type MiseOutcome =
  | { kind: "ok"; stdout: string }
  | { kind: "timeout" }
  | { kind: "failed"; detail: string };

function runMise(
  command: string,
  args: string[],
  options: { env: Record<string, string>; cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<MiseOutcome> {
  return new Promise((resolve, reject) => {
    let output = "";
    let stdout = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, {
      env: options.env,
      cwd: options.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString("utf8")).slice(-OUTPUT_TAIL);
      collect(chunk);
    });
    child.stderr.on("data", collect);
    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch (caughtError1) {
        journalCaught(caughtError1, "install.runMise.kill", null);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutMs);
    const onAbort = () => killGroup();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (outcome: MiseOutcome | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) reject(options.signal.reason);
      else if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    child.once("error", (error) =>
      finish({ kind: "failed", detail: `mise did not start (${error.message}).` }),
    );
    child.once("close", (code, signal) => {
      if (timedOut) return finish({ kind: "timeout" });
      if (code === 0) return finish({ kind: "ok", stdout });
      const last = lastLine(output);
      finish({
        kind: "failed",
        detail: `mise exited with ${signal ? `signal ${signal}` : `code ${code}`}${last ? `: ${last}` : "."}`,
      });
    });
  });
}

function lastLine(output: string): string {
  const lines = output
    // oxlint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const line = lines.at(-1) ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

function label(runtime: InstallRuntime): string {
  return `${runtime.tool}@${runtime.version}`;
}

function duration(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} minutes`;
  if (ms >= 1_000 && ms % 1_000 === 0) return `${ms / 1_000} seconds`;
  return `${ms} ms`;
}

/**
 * `path` with `binPaths` in front, so a runtime the task asked for wins over the system one.
 * With no bin paths, `path` comes back unchanged.
 */
/** `path` without the runner's own bin folder, for the agent and Closeout checks. */
export function withoutRunnerBin(path: string | undefined, bin: string = RUNNER_BIN_DIR): string {
  return (path ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0 && entry.replace(/\/+$/, "") !== bin)
    .join(delimiter);
}

export function prependRuntimePath(binPaths: readonly string[], path: string | undefined): string {
  if (!binPaths.length) return path ?? "";
  return [...binPaths, ...(path ? [path] : [])].join(delimiter);
}
