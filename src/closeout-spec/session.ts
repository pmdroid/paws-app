import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { anyPathMatches, pathsMatch } from "./policy/paths";
import { loadHomePolicy, type TreePolicy } from "./policy/resolve";
import { scrubCommandEnv } from "./run/env";
import { git } from "./run/exec";
import type { ResolvedItem, ResolvedRequirement, ResolvedSetup } from "./types";

export type CloseoutSession = {
  report(): Promise<string>;
  run(id: string, model?: string): Promise<string>;
};

export type CloseoutSessionOptions = {
  signal?: AbortSignal;
  allowCommand?: (argv: readonly string[]) => void;
};

type ItemMemory = {
  failures: number;
  passed: boolean;
  stale: boolean;
  kind: string;
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
  options: CloseoutSessionOptions = {},
): CloseoutSession {
  const memory = new Map<string, ItemMemory>();
  let fingerprint: string | undefined;
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
    const loaded = loadHomePolicy(workspace);
    if (!loaded.ok) return { kind: "blocked", message: loaded.message };
    if (loaded.absent) return { kind: "empty" };
    const policy = loaded.policy;
    const needsPaths = [...policy.setup, ...policy.items].some(
      (item) => item.paths !== undefined && item.paths.length > 0,
    );
    const changes = await changedPaths(workspace, needsPaths);
    if (!changes.ok) return { kind: "blocked", message: "changed paths are unavailable" };
    const next = fingerprintOf(workspace, changes.paths);
    if (fingerprint !== undefined && fingerprint !== next) {
      for (const state of memory.values()) {
        if (state.passed && state.kind !== "setup") {
          state.passed = false;
          state.stale = true;
        }
      }
    }
    fingerprint = next;
    return { kind: "ready", policy, required: select(policy, changes.paths) };
  };

  return {
    report: () => exclusive(async () => JSON.stringify(reportOf(await prepare(), memory))),
    run: (id) =>
      exclusive(async () => {
        const prepared = await prepare();
        if (prepared.kind === "blocked") return prepared.message;
        if (prepared.kind === "empty") return `No closeout check ${id}. Call get_closeout.`;
        return runId(workspace, prepared.policy, prepared.required, memory, id, options);
      }),
  };
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
      const setup = await execute(workspace, step, memory, options);
      if (!setup.ok) return setup.text;
    }
  }
  const result = await execute(workspace, item, memory, options);
  return result.text;
}

async function execute(
  workspace: string,
  item: Listed,
  memory: Map<string, ItemMemory>,
  options: CloseoutSessionOptions,
): Promise<{ ok: boolean; text: string }> {
  const argv = item.exec ?? [];
  try {
    options.allowCommand?.(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, text: message };
  }
  const result = await runCommand(workspace, argv, item.timeoutSeconds ?? 30, options.signal);
  if (result.cancelled) return { ok: false, text: `${item.id} was cancelled.` };
  const state = memory.get(item.id) ?? {
    failures: 0,
    passed: false,
    stale: false,
    kind: item.kind,
  };
  state.kind = item.kind;
  if (result.code === 0 && !result.timedOut) {
    state.passed = true;
    state.stale = false;
    memory.set(item.id, state);
    return { ok: true, text: `${item.id} passed.` };
  }
  state.failures += 1;
  state.passed = false;
  state.stale = false;
  memory.set(item.id, state);
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
): Promise<{ code: number; timedOut: boolean; cancelled: boolean; output: string }> {
  if (signal?.aborted) {
    return Promise.resolve({ code: 1, timedOut: false, cancelled: true, output: "" });
  }
  const command = argv[0];
  if (command === undefined || argv.some((part) => part.length === 0)) {
    return Promise.resolve({ code: 127, timedOut: false, cancelled: false, output: "" });
  }
  return new Promise((resolve) => {
    const child = spawn(command, argv.slice(1), {
      cwd: workspace,
      env: commandEnv(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const take = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 12_000) output = output.slice(-6_000);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
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
      resolve(result);
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
