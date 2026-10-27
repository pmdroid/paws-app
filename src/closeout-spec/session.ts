import { journalCaught } from "../journal";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { anyPathMatches, pathsMatch } from "./policy/paths";
import { loadMemoryPolicy, type TreePolicy } from "./policy/resolve";
import type { PolicyFilesLoad } from "./policy/load";
import { credentialSecrets, scrubCommandEnv } from "./run/env";
import { scrubText } from "./run/scrub";
import { git } from "./run/exec";
import { executeProbe, PROBE_TIMEOUT_SECONDS } from "./run/probe";
import { countEvidence, evidenceRequest, VISUAL_REVIEW_HINT } from "./evaluate/evaluate";
import { publishedAtHead } from "./published";
import type {
  PublishedEvidence,
  ResolvedEvidence,
  ResolvedItem,
  ResolvedRequirement,
  ResolvedRule,
  ResolvedSetup,
} from "./types";

export type SessionCommandResult = {
  argv: string[];
  head: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  timeoutSeconds: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
};

/**
 * A rule's probe result in the report that closes a turn. The host counts it only when the probe
 * hash, argv, head and timeout match its own policy and candidate.
 */
export type SessionRuleResult = {
  /** `probeArgv` of the rule at the base and head it ran against. */
  argv: string[];
  head: string;
  /** SHA-256 of the probe bytes that ran, from the policy, never from the checkout. */
  probeSha256: string;
  /** Null when the probe could not start or timed out. */
  exitCode: number | null;
  timedOut: boolean;
  dirty: boolean;
  headMoved: boolean;
  durationMs: number;
  timeoutSeconds: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
};

export type CloseoutSession = {
  /**
   * `probes` runs each listed rule's probe and adds its result. Only the runner asks for it, when
   * the turn ends; the agent's `get_closeout` and `run_closeout` never run a probe.
   */
  report(options?: { progress?: boolean; probes?: boolean }): Promise<string>;
  run(id: string, model?: string): Promise<string>;
};

export type CloseoutSessionOptions = {
  policy: () => Promise<PolicyFilesLoad>;
  signal?: AbortSignal;
  /**
   * Bin dirs of the task's installed runtimes. A check's `PATH` starts with them, so it finds
   * those runtimes before the system ones. Without them the check inherits `PATH` unchanged.
   */
  runtimeBinPaths?: readonly string[];
  /**
   * `PATH` a check starts from, before the runtime bin dirs. Without it the check inherits the
   * parent's `PATH`. The runner passes its own `PATH` minus the folder that holds its Bun.
   */
  basePath?: string;
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
const LOG_DIR = ".paws-closeout";
const MAX_LOG_CHARS = 16_000_000;

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
  evidence?: ResolvedEvidence;
};

type Prepared =
  | { kind: "empty" }
  | { kind: "blocked"; message: string }
  | {
      kind: "ready";
      policy: TreePolicy;
      required: Listed[];
      rules: ListedRule[];
      published: PublishedEvidence[];
    };

/** A rule the change must keep. Listing it does not run its probe. */
type ListedRule = {
  id: string;
  summary: string;
  matched_paths: string[];
  result?: SessionRuleResult;
};

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
      (caughtError1) => {
        journalCaught(caughtError1, "session.createCloseoutSession", null);
        return undefined;
      },
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
    const needsPaths = [...policy.setup, ...policy.items, ...policy.rules].some(
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
    const published = source.published
      ? await publishedAtHead(
          workspace,
          head,
          source.published,
          policy.items,
          commandEnv(),
          await comparisonBase(workspace),
        )
      : [];
    return {
      kind: "ready",
      policy,
      required: select(policy, changes.paths),
      rules: selectRules(policy.rules, changes.paths),
      published,
    };
  };

  return {
    report: (request) =>
      exclusive(async () => {
        const prepared = await prepare();
        if (request?.probes && prepared.kind === "ready")
          await runProbes(workspace, prepared, options);
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
        return runId(workspace, prepared, memory, id, options);
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
  } catch (caughtError1) {
    journalCaught(caughtError1, "session.notify.onProgress", null);
  }
}

function maxAttempts(policy: TreePolicy): number | null {
  return policy.retry?.maxFailedAttemptsPerItem ?? 3;
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
  const max = prepared.policy.retry?.maxFailedAttemptsPerItem ?? 3;
  const scope = prepared.policy.retry?.scope ?? null;
  const status = (item: Listed) =>
    item.evidence
      ? evidenceStatus(item.evidence, prepared.published)
      : statusOf(memory.get(item.id), item.kind === "setup" ? 2 : max);
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
      status: status(item),
      failed_attempts: failures,
      remaining_attempts:
        reviewCap !== undefined || max === null
          ? null
          : Math.max(0, (item.kind === "setup" ? 2 : max) - failures),
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
    .filter(
      (item) =>
        item.kind !== "review" &&
        (item.evidence
          ? status(item) === "missing"
          : runnable(memory.get(item.id), item.kind === "setup" ? 2 : max)),
    )
    .map((item) => item.id);
  const exhausted = prepared.required.filter(
    (item) => statusOf(memory.get(item.id), item.kind === "setup" ? 2 : max) === "exhausted",
  );
  const blocked =
    exhausted.length === 0 || max === null
      ? null
      : `Cannot finish yet. ${exhausted
          .map((item) => {
            const failures = memory.get(item.id)?.failures ?? 0;
            return `Check ${item.id} is exhausted. Failed attempts ${failures} of ${item.kind === "setup" ? 2 : max}. Hint: ${item.hint}.`;
          })
          .join(" ")}`;
  return {
    required,
    pending,
    blocked,
    bypassed: false,
    ...(prepared.rules.length > 0 ? { rules: prepared.rules } : {}),
  };
}

/**
 * Run each listed rule's policy probe against the workspace and keep its result on the listing.
 * The probe is written outside the workspace; see `executeProbe`.
 */
async function runProbes(
  workspace: string,
  prepared: Extract<Prepared, { kind: "ready" }>,
  options: CloseoutSessionOptions,
): Promise<void> {
  if (prepared.rules.length === 0) return;
  const base = await comparisonBase(workspace);
  const current = await git(workspace, ["rev-parse", "HEAD"], commandEnv());
  if (base === undefined || !current.ok) return;
  const head = current.stdout.toString("utf8").trim();
  const env = commandEnv({ runtimeBinPaths: options.runtimeBinPaths, basePath: options.basePath });
  for (const listed of prepared.rules) {
    const rule = prepared.policy.rules.find((entry) => entry.id === listed.id);
    const bytes = rule && prepared.policy.probeFiles.get(rule.probe);
    if (rule === undefined || bytes === undefined || options.signal?.aborted) continue;
    const ran = await executeProbe({
      rule,
      bytes,
      base,
      head,
      checkout: workspace,
      timeoutSeconds: PROBE_TIMEOUT_SECONDS,
      env,
    });
    listed.result = {
      argv: ran.argv,
      head,
      probeSha256: ran.probeSha256,
      exitCode: ran.exitCode,
      timedOut: ran.timedOut,
      dirty: ran.dirty,
      headMoved: ran.headMoved,
      durationMs: ran.durationMs,
      timeoutSeconds: PROBE_TIMEOUT_SECONDS,
      stdout: ran.stdout.slice(-24_000),
      stderr: ran.stderr.slice(-24_000),
      truncated: ran.truncated || ran.stdout.length > 24_000 || ran.stderr.length > 24_000,
    };
  }
}

function boundedReport(report: Record<string, unknown>): string {
  let text = JSON.stringify(report);
  const entries = [
    ...((report.required ?? []) as { result?: SessionCommandResult }[]),
    ...((report.rules ?? []) as { result?: SessionRuleResult }[]),
  ];
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

/**
 * `pending` means the files are published and a visual review in Paws comes
 * after this turn, so the check does not hold the agent back. The session has
 * no approvals; Paws Closeout judges them.
 */
function evidenceStatus(item: ResolvedEvidence, published: readonly PublishedEvidence[]): string {
  if (countEvidence(item, published) < item.minimum) return "missing";
  return item.approval === "human" ? "pending" : "passed";
}

function runnable(state: ItemMemory | undefined, max: number | null): boolean {
  const status = statusOf(state, max);
  return status !== "passed" && status !== "exhausted";
}

async function runId(
  workspace: string,
  prepared: Extract<Prepared, { kind: "ready" }>,
  memory: Map<string, ItemMemory>,
  id: string,
  options: CloseoutSessionOptions,
): Promise<string> {
  const { policy, required } = prepared;
  if (policy.rules.some((rule) => rule.id === id)) {
    return `Rule ${id} is not a check this session runs. Paws runs its probe from the Closeout policy after this turn.`;
  }
  const known = [...policy.setup, ...policy.items].find((item) => item.id === id);
  if (known === undefined) return `No closeout check ${id}. Call get_closeout.`;
  const item = required.find((entry) => entry.id === id);
  if (item === undefined) return `Check ${id} is not required for the current changes.`;
  if (item.kind === "review") {
    return `Review ${id} requires a different model. An independent reviewer runs it after this turn.`;
  }
  if (item.evidence) {
    const found = countEvidence(item.evidence, prepared.published);
    if (found >= item.evidence.minimum && item.evidence.approval === "human") {
      return `${id} has ${found} published. ${VISUAL_REVIEW_HINT}`;
    }
    if (found >= item.evidence.minimum) return `${id} passed. ${found} published.`;
    return `${id} runs nothing. It needs ${item.evidence.minimum - found} more of: ${item.evidence.media.join(", ")}. ${evidenceRequest(item.evidence)}`;
  }
  const max = policy.retry?.maxFailedAttemptsPerItem ?? 3;
  if (statusOf(memory.get(item.id), item.kind === "setup" ? 2 : max) === "exhausted") {
    return `Check ${id} is exhausted. Stop retrying and report the blocker.`;
  }
  if (item.kind === "command") {
    for (const step of required) {
      if (step.kind !== "setup" || step.id === item.id) continue;
      if (memory.get(step.id)?.passed) continue;
      if (statusOf(memory.get(step.id), 2) === "exhausted") {
        return `Check ${step.id} is exhausted. Stop retrying and report the blocker.`;
      }
      const setup = await execute(workspace, step, memory, options, 2);
      if (!setup.ok) return setup.text;
    }
  }
  const result = await execute(workspace, item, memory, options, item.kind === "setup" ? 2 : max);
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
    journalCaught(error, "session.execute.allowCommand", item?.id);
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
  const timeoutSeconds = item.timeoutSeconds ?? 30;
  const result = await runCommand(workspace, argv, timeoutSeconds, options.signal, {
    runtimeBinPaths: options.runtimeBinPaths,
    basePath: options.basePath,
  });
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
    timeoutSeconds,
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
  const log = writeLog(workspace, item.id, scrubText(result.full, credentialSecrets()));
  const failed = `${item.id} failed (${why}).${log ? ` Full output: ${log}` : ""}`;
  const tail = result.output.trim();
  return { ok: false, text: tail.length > 0 ? `${failed}\n${tail}` : failed };
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

function selectRules(rules: readonly ResolvedRule[], paths: readonly string[]): ListedRule[] {
  if (paths.length === 0) return [];
  return rules
    .filter((rule) => matches(rule, paths))
    .map((rule) => ({
      id: rule.id,
      summary: rule.summary,
      matched_paths: matchedPaths(rule, paths),
    }));
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
  if (item.kind === "evidence") {
    return {
      id: item.id,
      kind: item.kind,
      hint: evidenceRequest(item),
      differentModel: false,
      ...(item.paths !== undefined ? { paths: item.paths } : {}),
      matched,
      evidence: item,
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
  } catch (caughtError2) {
    journalCaught(caughtError2, "session.fileMark.lstatSync", null, "optional file may be absent");
    return "missing";
  }
}

function writeLog(workspace: string, id: string, output: string): string | undefined {
  const name = `${id.replace(/[^\w.-]/g, "_")}.log`;
  try {
    mkdirSync(join(workspace, LOG_DIR), { recursive: true });
    writeFileSync(join(workspace, LOG_DIR, ".gitignore"), "*\n");
    writeFileSync(join(workspace, LOG_DIR, name), output);
    return `${LOG_DIR}/${name}`;
  } catch (caughtError3) {
    journalCaught(caughtError3, "session.writeLog.mkdirSync", null);
    return undefined;
  }
}

function killCommand(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (caughtError4) {
    journalCaught(caughtError4, "session.killCommand.kill", null, "process may have exited");
    try {
      process.kill(pid, "SIGKILL");
    } catch (caughtError5) {
      journalCaught(caughtError5, "session.killCommand.kill", null, "process may have exited");
      return;
    }
  }
}

type CheckPath = { runtimeBinPaths?: readonly string[]; basePath?: string };

function commandEnv({ runtimeBinPaths = [], basePath }: CheckPath = {}): Record<string, string> {
  const env: Record<string, string> = {
    ...scrubCommandEnv(),
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  if (basePath !== undefined) env.PATH = basePath;
  if (runtimeBinPaths.length)
    env.PATH = [...runtimeBinPaths, ...(env.PATH ? [env.PATH] : [])].join(delimiter);
  return env;
}

function runCommand(
  workspace: string,
  argv: readonly string[],
  timeoutSeconds: number,
  signal?: AbortSignal,
  path?: CheckPath,
): Promise<{
  code: number;
  timedOut: boolean;
  cancelled: boolean;
  output: string;
  full: string;
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
      full: "",
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
      full: "",
      stdout: "",
      stderr: "",
      truncated: false,
    });
  }
  return new Promise((resolve) => {
    const child = spawn(command, argv.slice(1), {
      cwd: workspace,
      env: commandEnv(path),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let full = "";
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const take = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const text = (stream === "stdout" ? stdout : stderr) + chunk.toString("utf8");
      if (text.length > 24_000) truncated = true;
      if (stream === "stdout") stdout = text.slice(-24_000);
      else stderr = text.slice(-24_000);
      output += chunk.toString("utf8");
      if (full.length < MAX_LOG_CHARS) full += chunk.toString("utf8");
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
      resolve({ ...result, full, stdout, stderr, truncated });
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
