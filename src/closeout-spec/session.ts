import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { anyPathMatches, pathsMatch } from "./policy/paths";
import { loadMemoryPolicy, type TreePolicy } from "./policy/resolve";
import type { PolicyFilesLoad } from "./policy/load";
import { credentialSecrets, scrubCommandEnv } from "./run/env";
import { scrubText } from "./run/scrub";
import { git } from "./run/exec";
import type { ResolvedItem, ResolvedRequirement, ResolvedSetup } from "./types";

export type SessionCommandResult = {
  argv: string[];
  head: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
};

export type CloseoutSession = {
  report(options?: { progress?: boolean }): Promise<string>;
  run(id: string, model?: string): Promise<string>;
};

export type CloseoutSessionOptions = {
  policy: () => Promise<PolicyFilesLoad>;
  signal?: AbortSignal;
  allowCommand?: (argv: readonly string[]) => void;
  onProgress?: (event: CloseoutSessionEvent) => void;
};

export type CloseoutSessionCheck = {
  id: string;
  kind: string;
  command: string;
  status: string;
  failedAttempts: number;
};

export type CloseoutSessionEvent =
  | {
      type: "report";
      head: string;
      maxAttempts: number | null;
      checks: CloseoutSessionCheck[];
      blocked: string | null;
    }
  | {
      type: "started";
      head: string;
      id: string;
      kind: string;
      command: string;
      attempt: number;
      maxAttempts: number | null;
    }
  | {
      type: "finished";
      head: string;
      id: string;
      kind: string;
      command: string;
      attempt: number;
      maxAttempts: number | null;
      state: "passed" | "failed" | "exhausted" | "cancelled";
      exitCode: number | null;
      timedOut: boolean;
      durationMs: number;
      stdout: string;
      stderr: string;
      truncated: boolean;
    };

const PROGRESS_OUTPUT_CHARS = 16_000;

type ItemMemory = {
  failures: number;
  passed: boolean;
  stale: boolean;
  kind: string;
  result?: SessionCommandResult;
};

type Listed = {
  id: string;
  kind: string;
  hint: string;
  exec?: string[];
  timeoutSeconds?: number;
  paths?: string[];
  differentModel: boolean;
  matched: string[];
};

type Prepared =
  | { kind: "empty" }
  | { kind: "blocked"; message: string }
  | { kind: "ready"; policy: TreePolicy; required: Listed[] };

export function createCloseoutSession(
  workspace: string,
  options: CloseoutSessionOptions,
): CloseoutSession {
  const memory = new Map<string, ItemMemory>();
  let fingerprint: string | undefined;
  let checkedHead: string | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const run = chain.then(work, work);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const prepare = async (): Promise<Prepared> => {
    const source = await options.policy();
    if (!source.ok) return { kind: "blocked", message: source.message };
    if (source.absent) return { kind: "empty" };
    const loaded = loadMemoryPolicy(source.files);
    if (!loaded.ok) return { kind: "blocked", message: loaded.message };
    if (loaded.absent || loaded.policy.digest !== source.digest)
      return { kind: "blocked", message: "The Closeout policy does not match its digest" };
    const policy = loaded.policy;
    const needsPaths = [...policy.setup, ...policy.items].some(
      (item) => item.paths !== undefined && item.paths.length > 0,
    );
    const changes = await changedPaths(workspace, needsPaths);
    if (!changes.ok) return { kind: "blocked", message: "changed paths are unavailable" };
    const current = await git(workspace, ["rev-parse", "HEAD"], commandEnv());
    if (!current.ok) return { kind: "blocked", message: "candidate commit is unavailable" };
    const head = current.stdout.toString("utf8").trim();
    const next = `${head}:${policy.digest}:${fingerprintOf(workspace, changes.paths)}`;
    if (fingerprint !== undefined && fingerprint !== next) {
      for (const state of memory.values()) {
        if (state.passed && (state.kind !== "setup" || checkedHead !== head)) {
          state.passed = false;
          state.stale = true;
        }
      }
    }
    fingerprint = next;
    checkedHead = head;
    return { kind: "ready", policy, required: select(policy, changes.paths) };
  };

  return {
    report: (request) =>
      exclusive(async () => {
        const prepared = await prepare();
        const report = reportOf(prepared, memory);
        if (request?.progress && checkedHead !== undefined)
          notifyReport(options, checkedHead, prepared, report);
        return boundedReport(report);
      }),
    run: (id) =>
      exclusive(async () => {
        const prepared = await prepare();
        if (prepared.kind === "blocked") return prepared.message;
        if (prepared.kind === "empty") return `No closeout check ${id}. Call get_closeout.`;
        return runId(workspace, prepared.policy, prepared.required, memory, id, options);
      }),
  };
}

function notifyReport(
  options: CloseoutSessionOptions,
  head: string,
  prepared: Prepared,
  report: Record<string, unknown>,
): void {
  if (!options.onProgress) return;
  const commands = new Map(
    prepared.kind === "ready"
      ? prepared.required.map((item) => [item.id, item.exec?.join(" ") ?? item.hint])
      : [],
  );
  const required = report.required as {
    id: string;
    kind: string;
    status: string;
    failed_attempts: number;
  }[];
  notify(options, {
    type: "report",
    head,
    maxAttempts: prepared.kind === "ready" ? maxAttempts(prepared.policy) : null,
    checks: required.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      command: commands.get(entry.id) ?? entry.id,
      status: entry.status,
      failedAttempts: entry.failed_attempts,
    })),
    blocked: typeof report.blocked === "string" ? report.blocked : null,
  });
}

function notify(options: CloseoutSessionOptions, event: CloseoutSessionEvent): void {
  try {
    options.onProgress?.(event);
  } catch {}
}

function maxAttempts(policy: TreePolicy): number | null {
  return policy.retry?.maxFailedAttemptsPerItem ?? null;
}

function lastChars(text: string): { text: string; cut: boolean } {
  return text.length > PROGRESS_OUTPUT_CHARS
    ? { text: text.slice(-PROGRESS_OUTPUT_CHARS), cut: true }
    : { text, cut: false };
}

function reportOf(prepared: Prepared, memory: Map<string, ItemMemory>): Record<string, unknown> {
  if (prepared.kind === "empty") {
    return { required: [], pending: [], blocked: null, bypassed: false };
  }
  if (prepared.kind === "blocked") {
    return { required: [], pending: [], blocked: prepared.message, bypassed: false };
  }
  const max = prepared.policy.retry?.maxFailedAttemptsPerItem ?? null;
  const scope = prepared.policy.retry?.scope ?? null;
  const required = prepared.required.map((item) => {
    const state = memory.get(item.id);
    const failures = state?.failures ?? 0;
    const reviewCap =
      item.kind === "review" ? prepared.policy.retry?.maxFailedReviewAttempts : undefined;
    return {
      id: item.id,
      kind: item.kind,
      hint: item.hint,
      matched_paths: item.matched,
      status: statusOf(state, max),
      failed_attempts: failures,
      remaining_attempts:
        reviewCap !== undefined || max === null ? null : Math.max(0, max - failures),
      ...(reviewCap !== undefined
        ? {
            retry_limits: {
              max_failed_review_attempts: reviewCap,
              max_failed_attempts_per_key: max,
            },
          }
        : {}),
      retry_scope: scope,
      different_model: item.differentModel,
      ...(state?.result && !state.stale ? { result: state.result } : {}),
    };
  });
  const pending = prepared.required
    .filter((item) => item.kind !== "review" && runnable(memory.get(item.id), max))
    .map((item) => item.id);
  const exhausted = prepared.required.filter(
    (item) => statusOf(memory.get(item.id), max) === "exhausted",
  );
  const blocked =
    exhausted.length === 0 || max === null
      ? null
      : `Cannot finish yet. ${exhausted
          .map((item) => {
            const failures = memory.get(item.id)?.failures ?? 0;
            return `Check ${item.id} is exhausted. Failed attempts ${failures} of ${max}. Hint: ${item.hint}.`;
          })
          .join(" ")}`;
  return { required, pending, blocked, bypassed: false };
}

function boundedReport(report: Record<string, unknown>): string {
  let text = JSON.stringify(report);
  const entries = (report.required ?? []) as { result?: SessionCommandResult }[];
  while (Buffer.byteLength(text) > 60_000) {
    const streams = entries.flatMap(({ result }) =>
      result ? (["stdout", "stderr"] as const).map((key) => ({ result, key })) : [],
    );
    streams.sort((a, b) => b.result[b.key].length - a.result[a.key].length);
    const largest = streams[0];
    if (!largest || largest.result[largest.key].length === 0) break;
    largest.result[largest.key] = largest.result[largest.key].slice(
      Math.ceil(largest.result[largest.key].length / 2),
    );
    largest.result.truncated = true;
    text = JSON.stringify(report);
  }
  return text;
}

function statusOf(state: ItemMemory | undefined, max: number | null): string {
  const failures = state?.failures ?? 0;
  if (max !== null && failures >= max) return "exhausted";
  if (state?.passed) return "passed";
  if (state?.stale) return "stale";
  if (failures > 0) return "failed";
  return "missing";
}

function runnable(state: ItemMemory | undefined, max: number | null): boolean {
  const status = statusOf(state, max);
  return status !== "passed" && status !== "exhausted";
}

async function runId(
  workspace: string,
  policy: TreePolicy,
  required: readonly Listed[],
  memory: Map<string, ItemMemory>,
  id: string,
  options: CloseoutSessionOptions,
): Promise<string> {
  const known = [...policy.setup, ...policy.items].find((item) => item.id === id);
  if (known === undefined) return `No closeout check ${id}. Call get_closeout.`;
  const item = required.find((entry) => entry.id === id);
  if (item === undefined) return `Check ${id} is not required for the current changes.`;
  if (item.kind === "review") {
    return `Review ${id} requires a different model. An independent reviewer runs it after this turn.`;
  }
  const max = policy.retry?.maxFailedAttemptsPerItem ?? null;
  if (statusOf(memory.get(item.id), max) === "exhausted") {
    return `Check ${id} is exhausted. Stop retrying and report the blocker.`;
  }
  if (item.kind === "command") {
    for (const step of required) {
      if (step.kind !== "setup" || step.id === item.id) continue;
      if (memory.get(step.id)?.passed) continue;
      if (statusOf(memory.get(step.id), max) === "exhausted") {
        return `Check ${step.id} is exhausted. Stop retrying and report the blocker.`;
      }
      const setup = await execute(workspace, step, memory, options, max);
      if (!setup.ok) return setup.text;
    }
  }
  const result = await execute(workspace, item, memory, options, max);
  return result.text;
}

async function execute(
  workspace: string,
  item: Listed,
  memory: Map<string, ItemMemory>,
  options: CloseoutSessionOptions,
  max: number | null,
): Promise<{ ok: boolean; text: string }> {
  const argv = item.exec ?? [];
  try {
    options.allowCommand?.(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, text: message };
  }
  const before = await git(workspace, ["rev-parse", "HEAD"], commandEnv());
  const progress = {
    head: before.ok ? before.stdout.toString("utf8").trim() : "",
    id: item.id,
    kind: item.kind,
    command: argv.join(" "),
    attempt: (memory.get(item.id)?.failures ?? 0) + 1,
    maxAttempts: max,
  };
  notify(options, { type: "started", ...progress });
  const started = Date.now();
  const result = await runCommand(workspace, argv, item.timeoutSeconds ?? 30, options.signal);
  const after = await git(workspace, ["rev-parse", "HEAD"], commandEnv());
  if (result.cancelled) {
    notify(options, {
      type: "finished",
      ...progress,
      state: "cancelled",
      exitCode: null,
      timedOut: false,
      durationMs: Math.max(1, Date.now() - started),
      stdout: "",
      stderr: "",
      truncated: false,
    });
    return { ok: false, text: `${item.id} was cancelled.` };
  }
  const state = memory.get(item.id) ?? {
    failures: 0,
    passed: false,
    stale: false,
    kind: item.kind,
  };
  state.result = {
    argv: [...argv],
    head:
      before.ok && after.ok && before.stdout.equals(after.stdout)
        ? after.stdout.toString("utf8").trim()
        : "",
    exitCode: result.code,
    timedOut: result.timedOut,
    durationMs: Math.max(1, Date.now() - started),
    stdout: scrubText(result.stdout, credentialSecrets()),
    stderr: scrubText(result.stderr, credentialSecrets()),
    truncated: result.truncated,
  };
  state.kind = item.kind;
  const finished = (outcome: "passed" | "failed" | "exhausted") => {
    const stdout = lastChars(state.result!.stdout);
    const stderr = lastChars(state.result!.stderr);
    notify(options, {
      type: "finished",
      ...progress,
      state: outcome,
      exitCode: result.code,
      timedOut: result.timedOut,
      durationMs: state.result!.durationMs,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: result.truncated || stdout.cut || stderr.cut,
    });
  };
  if (result.code === 0 && !result.timedOut) {
    state.passed = true;
    state.stale = false;
    memory.set(item.id, state);
    finished("passed");
    return { ok: true, text: `${item.id} passed.` };
  }
  state.failures += 1;
  state.passed = false;
  state.stale = false;
  memory.set(item.id, state);
  finished(max !== null && state.failures >= max ? "exhausted" : "failed");
  const why = result.timedOut ? "timed out" : `exit ${result.code}`;
  const tail = result.output.trim();
  return {
    ok: false,
    text: tail.length > 0 ? `${item.id} failed (${why}).\n${tail}` : `${item.id} failed (${why}).`,
  };
}

function select(policy: TreePolicy, paths: readonly string[]): Listed[] {
  if (paths.length === 0) return [];
  const items = policy.items.filter(
    (item) => item.gate === "beforePR" && matches(item, paths) && !("supported" in item),
  );
  if (items.length === 0) return [];
  const setup = policy.setup.filter((step) => step.gate === "beforePR" && matches(step, paths));
  return [...setup, ...items].map((item) => describeItem(item, paths));
}

function matches(item: { paths?: string[] }, paths: readonly string[]): boolean {
  if (item.paths === undefined || item.paths.length === 0) return true;
  return anyPathMatches(item.paths, paths);
}

function describeItem(item: ResolvedSetup | ResolvedRequirement, paths: readonly string[]): Listed {
  const matched = matchedPaths(item, paths);
  if ("supported" in item) {
    return {
      id: item.id,
      kind: item.kind,
      hint: item.id,
      differentModel: false,
      ...(item.paths !== undefined ? { paths: item.paths } : {}),
      matched,
    };
  }
  if (item.kind === "review") {
    return {
      id: item.id,
      kind: item.kind,
      hint: `Review using ${item.skill}`,
      differentModel: item.independence.differentModel,
      ...(item.paths !== undefined ? { paths: item.paths } : {}),
      matched,
    };
  }
  return {
    id: item.id,
    kind: item.kind,
    hint: `Run ${item.exec.join(" ")}`,
    exec: item.exec,
    timeoutSeconds: item.timeoutSeconds,
    differentModel: false,
    ...(item.paths !== undefined ? { paths: item.paths } : {}),
    matched,
  };
}

function matchedPaths(item: Pick<ResolvedItem, "paths">, paths: readonly string[]): string[] {
  const patterns = item.paths;
  const matched =
    patterns === undefined || patterns.length === 0
      ? paths
      : paths.filter((path) => patterns.some((pattern) => pathsMatch(pattern, path)));
  return [...matched].sort();
}

async function changedPaths(
  workspace: string,
  needed: boolean,
): Promise<{ ok: true; paths: string[] } | { ok: false }> {
  const base = await comparisonBase(workspace);
  if (base === undefined) return { ok: false };
  const listed = await listChanges(workspace, base);
  if (listed === undefined) return needed ? { ok: false } : { ok: true, paths: ["."] };
  return listed;
}

async function comparisonBase(workspace: string): Promise<string | undefined> {
  const merged = await git(workspace, ["merge-base", "HEAD", "origin/main"], commandEnv());
  if (!merged.ok) return undefined;
  const sha = merged.stdout.toString("utf8").trim();
  return sha.length > 0 ? sha : undefined;
}

async function listChanges(
  workspace: string,
  base: string,
): Promise<{ ok: true; paths: string[] } | undefined> {
  const env = commandEnv();
  const diff = await git(workspace, ["diff", "--name-only", "--no-renames", "-z", base, "--"], env);
  if (!diff.ok) return undefined;
  const untracked = await git(workspace, ["ls-files", "--others", "--exclude-standard", "-z"], env);
  if (!untracked.ok) return undefined;
  const paths = new Set<string>();
  for (const path of names(diff.stdout)) paths.add(path);
  for (const path of names(untracked.stdout)) paths.add(path);
  return { ok: true, paths: [...paths].sort() };
}

function names(stdout: Buffer): string[] {
  return stdout
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0 && !path.split("/").includes(".."));
}

function fingerprintOf(workspace: string, paths: readonly string[]): string {
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) {
    hash.update(path);
    hash.update("\0");
    hash.update(fileMark(workspace, path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function fileMark(workspace: string, path: string): Buffer | string {
  const absolute = join(workspace, ...path.split("/"));
  const root = join(workspace);
  if (absolute !== root && !absolute.startsWith(`${root}/`)) return "outside";
  try {
    const info = lstatSync(absolute);
    if (info.isSymbolicLink()) return "link";
    if (!info.isFile()) return "other";
    return readFileSync(absolute);
  } catch {
    return "missing";
  }
}

function killCommand(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return;
    }
  }
}

function commandEnv(): Record<string, string> {
  return {
    ...scrubCommandEnv(),
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function runCommand(
  workspace: string,
  argv: readonly string[],
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<{
  code: number;
  timedOut: boolean;
  cancelled: boolean;
  output: string;
  stdout: string;
  stderr: string;
  truncated: boolean;
}> {
  if (signal?.aborted) {
    return Promise.resolve({
      code: 1,
      timedOut: false,
      cancelled: true,
      output: "",
      stdout: "",
      stderr: "",
      truncated: false,
    });
  }
  const command = argv[0];
  if (command === undefined || argv.some((part) => part.length === 0)) {
    return Promise.resolve({
      code: 127,
      timedOut: false,
      cancelled: false,
      output: "",
      stdout: "",
      stderr: "",
      truncated: false,
    });
  }
  return new Promise((resolve) => {
    const child = spawn(command, argv.slice(1), {
      cwd: workspace,
      env: commandEnv(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const take = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const text = (stream === "stdout" ? stdout : stderr) + chunk.toString("utf8");
      if (text.length > 24_000) truncated = true;
      if (stream === "stdout") stdout = text.slice(-24_000);
      else stderr = text.slice(-24_000);
      output += chunk.toString("utf8");
      if (output.length > 12_000) output = output.slice(-6_000);
    };
    child.stdout.on("data", (chunk: Buffer) => take("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => take("stderr", chunk));
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      cancelled = true;
      killCommand(child.pid);
    };
    const finish = (result: {
      code: number;
      timedOut: boolean;
      cancelled: boolean;
      output: string;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ ...result, stdout, stderr, truncated });
    };
    signal?.addEventListener("abort", onAbort);
    timer = setTimeout(() => {
      timedOut = true;
      killCommand(child.pid);
    }, timeoutSeconds * 1000);
    child.on("error", () =>
      finish({ code: 127, timedOut, cancelled, output: output.slice(-6_000) }),
    );
    child.on("close", (code) =>
      finish({ code: code ?? 1, timedOut, cancelled, output: output.slice(-6_000) }),
    );
    if (signal?.aborted) onAbort();
  });
}
