import { journalCaught } from "../journal";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { anyPathMatches, pathsMatch } from "./policy/paths";
import { loadMemoryPolicy, type TreePolicy } from "./policy/resolve";
import type { PolicyFilesLoad } from "./policy/load";
import { changesPolicyInput } from "./policy/inputs";
import { POLICY_SCHEMA_SUMMARY } from "./policy/schema-summary";
import { credentialSecrets, scrubCommandEnv } from "./run/env";
import { scrubText } from "./run/scrub";
import { git } from "./run/exec";
import { executeProbe, PROBE_TIMEOUT_SECONDS } from "./run/probe";
import {
  countEvidence,
  evidenceRequest,
  previewRequest,
  VISUAL_REVIEW_HINT,
} from "./evaluate/evaluate";
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
   * `probes` adds each listed rule's result. A probe runs at most once per fingerprint (head,
   * policy digest and changed files). `get_closeout` in implement and fix turns and the turn-end
   * report ask for it. A result never changes `pending` or `blocked` unless `rulesFirst` is set.
   */
  report(options?: { progress?: boolean; probes?: boolean }): Promise<string>;
  run(id: string, model?: string): Promise<string>;
  /**
   * The report from the policy and results this session already holds, without loading the
   * policy again. When the head or the changed files moved since then, checks that had passed
   * are pending, as a new report would list them. Undefined until a report or run listed a policy.
   */
  recorded(): Promise<string | undefined>;
  /**
   * The last report `report` or `recorded` returned, when the workspace head is still the head it
   * was recorded at. Reads only `HEAD`, not the changed files.
   */
  lastRecorded(): Promise<string | undefined>;
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
  rulesFirst?: boolean;
  focus?: CloseoutFocus;
};

export type CloseoutFocus = {
  scope: "failed" | "changed";
  head: string;
  policyDigest: string;
  passed: readonly string[];
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
      base?: string;
      policyDigest?: string;
      clean?: boolean;
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
      deferred: Deferred;
      policyChanged: boolean;
    };

/** `failed` are the command checks that did not pass on the focus head; they run first. */
type Deferred = { head: string; ids: ReadonlySet<string>; failed: ReadonlySet<string> } | undefined;

/** A rule the change must keep. `result` is set when the report asked for probes. */
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
  let probed = new Map<string, SessionRuleResult>();
  let probedFingerprint: string | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let listed: Prepared | undefined;
  let last: { report: string; head: string | undefined } | undefined;
  const halt: Halt = { controller: new AbortController(), finished: 0, last: new Map() };
  const running = new Map<string, Promise<{ ok: boolean; text: string }>>();
  const once: Once = (id, work) => {
    let run = running.get(id);
    if (!run) {
      run = work().finally(() => running.delete(id));
      running.set(id, run);
    }
    return run;
  };

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
    const current = await candidateOf(workspace, policy);
    if (!current.ok) return { kind: "blocked", message: current.message };
    const { head, paths, fingerprint: next } = current;
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
    const required = select(policy, paths);
    return {
      kind: "ready",
      policy,
      required,
      rules: selectRules(policy.rules, paths),
      published,
      deferred: await deferredOf(workspace, policy, required, options.focus),
      policyChanged: changesPolicyInput(policy, paths),
    };
  };

  const judgeRules = async (prepared: Prepared): Promise<void> => {
    if (prepared.kind !== "ready") return;
    if (!options.rulesFirst && !commandsPassed(prepared, memory)) return;
    if (probedFingerprint !== fingerprint) {
      probed = new Map();
      probedFingerprint = fingerprint;
    }
    const unprobed = prepared.rules.filter((rule) => !probed.has(rule.id));
    if (unprobed.length > 0) {
      await runProbes(workspace, { ...prepared, rules: unprobed }, options);
      for (const rule of unprobed) if (rule.result) probed.set(rule.id, rule.result);
    }
    for (const rule of prepared.rules) {
      const result = probed.get(rule.id);
      if (result) rule.result = result;
    }
  };

  const ruleBreak = (prepared: Prepared): string | undefined => {
    if (!options.rulesFirst || prepared.kind !== "ready") return undefined;
    const broken = prepared.rules.find((rule) => rule.result && ruleBroke(rule.result));
    return broken
      ? `Rule ${broken.id} broke. Stop and finish this turn; Paws asks the team about it before any check runs.`
      : undefined;
  };

  return {
    report: (request) =>
      exclusive(async () => {
        const prepared = await prepare();
        listed = prepared;
        if (request?.probes || options.rulesFirst) await judgeRules(prepared);
        const broken = ruleBreak(prepared);
        const report = {
          ...reportOf(prepared, memory),
          ...(broken ? { pending: [], blocked: broken } : {}),
        };
        if (request?.progress && checkedHead !== undefined)
          notifyReport(options, checkedHead, prepared, report);
        last = { report: boundedReport(report), head: checkedHead };
        return last.report;
      }),
    run: async (id) => {
      const since = halt.finished;
      const ready = await exclusive(async () => {
        const prepared = await prepare();
        listed = prepared;
        if (prepared.kind === "blocked") return prepared.message;
        if (prepared.kind === "empty") return `No closeout check ${id}. Call get_closeout.`;
        if (options.rulesFirst) await judgeRules(prepared);
        return ruleBreak(prepared) ?? prepared;
      });
      if (typeof ready === "string") return ready;
      return runId(workspace, ready, memory, id, options, once, { halt, since });
    },
    recorded: async () => {
      let prepared = listed;
      // A blocked listing may be a policy load that failed; only a new report can clear it.
      if (prepared === undefined || prepared.kind === "blocked") return undefined;
      let view = memory;
      let recordedHead = checkedHead;
      if (prepared.kind === "ready") {
        const current = await candidateOf(workspace, prepared.policy);
        if (!current.ok) {
          prepared = { kind: "blocked", message: current.message };
        } else if (current.fingerprint !== fingerprint) {
          const head = current.head;
          view = new Map(
            [...memory].map(([id, state]) => [
              id,
              state.passed && (state.kind !== "setup" || checkedHead !== head)
                ? { ...state, passed: false, stale: true }
                : state,
            ]),
          );
          // Select again for the files as they are now; published evidence and rule results
          // belong to the old candidate.
          const required = select(prepared.policy, current.paths);
          prepared = {
            ...prepared,
            required,
            rules: selectRules(prepared.policy.rules, current.paths),
            published: [],
            deferred: await deferredOf(workspace, prepared.policy, required, options.focus),
            policyChanged: changesPolicyInput(prepared.policy, current.paths),
          };
        }
        recordedHead = current.ok ? current.head : undefined;
      }
      const broken = ruleBreak(prepared);
      last = {
        report: boundedReport({
          ...reportOf(prepared, view),
          ...(broken ? { pending: [], blocked: broken } : {}),
        }),
        head: recordedHead,
      };
      return last.report;
    },
    lastRecorded: async () => {
      if (last === undefined || last.head === undefined) return undefined;
      const current = await git(workspace, ["rev-parse", "HEAD"], commandEnv());
      if (!current.ok || current.stdout.toString("utf8").trim() !== last.head) return undefined;
      return last.report;
    },
  };
}

/** The candidate's head and its fingerprint: head, policy digest and changed files. */
async function candidateOf(
  workspace: string,
  policy: TreePolicy,
): Promise<
  { ok: true; head: string; paths: string[]; fingerprint: string } | { ok: false; message: string }
> {
  const needsPaths = [...policy.setup, ...policy.items, ...policy.rules].some(
    (item) => item.paths !== undefined && item.paths.length > 0,
  );
  const changes = await changedPaths(workspace, needsPaths);
  if (!changes.ok) return { ok: false, message: "changed paths are unavailable" };
  const current = await git(workspace, ["rev-parse", "HEAD"], commandEnv());
  if (!current.ok) return { ok: false, message: "candidate commit is unavailable" };
  const head = current.stdout.toString("utf8").trim();
  return {
    ok: true,
    head,
    paths: changes.paths,
    fingerprint: `${head}:${policy.digest}:${fingerprintOf(workspace, changes.paths)}`,
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
  const { deferred } = prepared;
  const deferredNow = (item: Listed) => {
    if (!deferred?.ids.has(item.id)) return false;
    const now = statusOf(memory.get(item.id), item.kind === "setup" ? 2 : max);
    return now === "missing" || now === "stale";
  };
  const status = (item: Listed) =>
    item.kind === "preview"
      ? "pending"
      : item.evidence
        ? evidenceStatus(item.evidence, prepared.published)
        : deferredNow(item)
          ? "deferred"
          : statusOf(memory.get(item.id), item.kind === "setup" ? 2 : max);
  const order = runOrder(prepared, memory);
  const blocker = failingCheck(prepared, memory);
  const blockerExhausted =
    blocker !== undefined && statusOf(memory.get(blocker), max) === "exhausted";
  // A check that waits on an exhausted one cannot run this turn; Closeout runs it at the end.
  const waiting = (item: Listed) =>
    blocker !== undefined &&
    item.id !== blocker &&
    (item.kind === "command" || item.kind === "setup") &&
    ["missing", "stale"].includes(status(item));
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
      status: blockerExhausted && waiting(item) ? "deferred" : status(item),
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
      ...(deferred && deferredNow(item)
        ? { note: `passed on ${deferred.head.slice(0, 12)}; Closeout reruns it at the end` }
        : {}),
      ...(waiting(item) ? { detail: `not run: fix ${blocker} first` } : {}),
      ...(state?.result && !state.stale ? { result: state.result } : {}),
    };
  });
  const pending = prepared.required
    .filter(
      (item) =>
        item.kind !== "review" &&
        item.kind !== "preview" &&
        !deferredNow(item) &&
        !(blockerExhausted && waiting(item)) &&
        (item.evidence
          ? status(item) === "missing"
          : runnable(memory.get(item.id), item.kind === "setup" ? 2 : max)),
    )
    .map((item) => item.id)
    .sort((left, right) => rank(order, left) - rank(order, right));
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
    ...(prepared.policyChanged ? { policy_schema: POLICY_SCHEMA_SUMMARY } : {}),
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

function ruleBroke(result: SessionRuleResult): boolean {
  return !result.timedOut && result.exitCode !== null && result.exitCode !== 0;
}

const MATCHED_PATHS_KEPT = 20;

function boundedReport(report: Record<string, unknown>): string {
  let text = JSON.stringify(report);
  const entries = [
    ...((report.required ?? []) as { result?: SessionCommandResult }[]),
    ...((report.rules ?? []) as { result?: SessionRuleResult }[]),
  ];
  if (Buffer.byteLength(text) > 60_000) {
    for (const entry of entries as { matched_paths?: string[]; matched_paths_omitted?: number }[]) {
      const paths = entry.matched_paths;
      if (!paths || paths.length <= MATCHED_PATHS_KEPT) continue;
      entry.matched_paths_omitted = paths.length - MATCHED_PATHS_KEPT;
      entry.matched_paths = paths.slice(0, MATCHED_PATHS_KEPT);
    }
    text = JSON.stringify(report);
  }
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

type Once = (
  id: string,
  work: () => Promise<{ ok: boolean; text: string }>,
) => Promise<{ ok: boolean; text: string }>;

type Halt = {
  controller: AbortController;
  finished: number;
  last: Map<string, { at: number; result: { ok: boolean; text: string } }>;
};

function commandsPassed(
  prepared: Extract<Prepared, { kind: "ready" }>,
  memory: Map<string, ItemMemory>,
): boolean {
  return prepared.required
    .filter((item) => item.kind === "setup" || item.kind === "command")
    .every((item) => memory.get(item.id)?.passed === true || isDeferred(prepared, memory, item));
}

function commandPhases(
  prepared: Extract<Prepared, { kind: "ready" }>,
  memory: Map<string, ItemMemory>,
): Listed[][] {
  const max = maxAttempts(prepared.policy);
  const commands = prepared.required.filter(
    (item) => item.kind === "command" && item.exec && !isDeferred(prepared, memory, item),
  );
  const timeout = (item: Listed) => item.timeoutSeconds ?? 30;
  const longest = Math.max(...commands.map(timeout));
  const failed = commands.filter((item) => {
    const status = statusOf(memory.get(item.id), max);
    return (
      status === "failed" ||
      status === "exhausted" ||
      (prepared.deferred?.failed.has(item.id) === true && status !== "passed")
    );
  });
  const rest = commands.filter((item) => !failed.includes(item));
  const slow = commands.some((item) => timeout(item) < longest)
    ? rest.filter((item) => timeout(item) === longest)
    : [];
  return [failed, rest.filter((item) => !slow.includes(item)), slow].filter(
    (phase) => phase.length > 0,
  );
}

function runOrder(
  prepared: Extract<Prepared, { kind: "ready" }>,
  memory: Map<string, ItemMemory>,
): string[] {
  return [
    ...prepared.required.filter((item) => item.kind === "setup"),
    ...commandPhases(prepared, memory).flat(),
  ].map((item) => item.id);
}

function rank(order: readonly string[], id: string): number {
  const index = order.indexOf(id);
  return index === -1 ? order.length : index;
}

function failingCheck(
  prepared: Extract<Prepared, { kind: "ready" }>,
  memory: Map<string, ItemMemory>,
): string | undefined {
  const max = maxAttempts(prepared.policy);
  return runOrder(prepared, memory).find((id) => {
    const item = prepared.required.find((entry) => entry.id === id);
    const status = statusOf(memory.get(id), item?.kind === "setup" ? 2 : max);
    return status === "failed" || status === "exhausted";
  });
}

function isDeferred(
  prepared: Extract<Prepared, { kind: "ready" }>,
  memory: Map<string, ItemMemory>,
  item: Listed,
): boolean {
  if (!prepared.deferred?.ids.has(item.id)) return false;
  const now = statusOf(memory.get(item.id), maxAttempts(prepared.policy));
  return now === "missing" || now === "stale";
}

async function runId(
  workspace: string,
  prepared: Extract<Prepared, { kind: "ready" }>,
  memory: Map<string, ItemMemory>,
  id: string,
  options: CloseoutSessionOptions,
  once: Once,
  { halt, since }: { halt: Halt; since: number },
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
  if (item.kind === "preview") return `${id} runs nothing. ${item.hint}`;
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
  const digest = policy.digest;
  if (item.kind === "command" || item.kind === "setup") {
    const before = item.kind === "setup" ? required.indexOf(item) : required.length;
    for (const step of required.slice(0, before)) {
      if (step.kind !== "setup") continue;
      if (memory.get(step.id)?.passed) continue;
      if (statusOf(memory.get(step.id), 2) === "exhausted") {
        return `Check ${step.id} is exhausted. Stop retrying and report the blocker.`;
      }
      const setup = await once(step.id, () => execute(workspace, step, memory, options, 2, digest));
      if (!setup.ok) return setup.text;
    }
  }
  const command = async (step: Listed) => {
    const recent = halt.last.get(step.id);
    if (recent !== undefined && recent.at > since) return recent.result;
    const result = await once(step.id, () =>
      execute(workspace, step, memory, options, max, digest, halt),
    );
    halt.last.set(step.id, { at: ++halt.finished, result });
    return result;
  };
  if (item.kind === "command") {
    for (const phase of commandPhases(prepared, memory)) {
      if (phase.includes(item)) break;
      const stuck = phase.find((step) => statusOf(memory.get(step.id), max) === "exhausted");
      if (stuck)
        return `${id} not run: fix ${stuck.id} first. Check ${stuck.id} is exhausted. Stop retrying and report the blocker.`;
      const results = await Promise.all(
        phase
          .filter((step) => runnable(memory.get(step.id), max))
          .map(async (step) => ({ step, result: await command(step) })),
      );
      const failed =
        results.find(
          ({ step, result }) =>
            !result.ok && ["failed", "exhausted"].includes(statusOf(memory.get(step.id), max)),
        ) ?? results.find(({ result }) => !result.ok);
      if (failed) return `${id} not run: fix ${failed.step.id} first.\n${failed.result.text}`;
    }
    return (await command(item)).text;
  }
  const result = await once(item.id, () => execute(workspace, item, memory, options, 2, digest));
  return result.text;
}

async function execute(
  workspace: string,
  item: Listed,
  memory: Map<string, ItemMemory>,
  options: CloseoutSessionOptions,
  max: number | null,
  policyDigest: string,
  halt?: Halt,
): Promise<{ ok: boolean; text: string }> {
  const argv = item.exec ?? [];
  const stop = halt?.controller.signal;
  try {
    options.allowCommand?.(argv);
  } catch (error) {
    journalCaught(error, "session.execute.allowCommand", item?.id);
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, text: message };
  }
  const before = await git(workspace, ["rev-parse", "HEAD"], commandEnv());
  const base = await comparisonBase(workspace);
  const cleanBefore = await clean(workspace);
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
  const signals = [options.signal, stop].filter((signal) => signal !== undefined);
  const result = await runCommand(
    workspace,
    argv,
    timeoutSeconds,
    signals.length > 0 ? AbortSignal.any(signals) : undefined,
    {
      runtimeBinPaths: options.runtimeBinPaths,
      basePath: options.basePath,
      bail: item.kind === "command",
    },
  );
  const after = await git(workspace, ["rev-parse", "HEAD"], commandEnv());
  const cleanAfter = await clean(workspace);
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
    if (stop?.aborted && !options.signal?.aborted)
      return { ok: false, text: `${item.id} not run: fix ${String(stop.reason)} first.` };
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
      base: base ?? "",
      policyDigest,
      clean: cleanBefore && cleanAfter && state.result!.head !== "",
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
  if (halt) {
    const running = halt.controller;
    halt.controller = new AbortController();
    running.abort(item.id);
  }
  finished(max !== null && state.failures >= max ? "exhausted" : "failed");
  const why = result.timedOut ? "timed out" : `exit ${result.code}`;
  const log = writeLog(workspace, item.id, scrubText(result.full, credentialSecrets()));
  const failed = `${item.id} failed (${why}).${log ? ` Full output: ${log}` : ""}`;
  const tail = result.output.trim();
  return { ok: false, text: tail.length > 0 ? `${failed}\n${tail}` : failed };
}

async function deferredOf(
  workspace: string,
  policy: TreePolicy,
  required: readonly Listed[],
  focus: CloseoutFocus | undefined,
): Promise<Deferred> {
  if (focus === undefined || focus.policyDigest !== policy.digest) return undefined;
  let since: string[] = [];
  if (focus.scope === "changed") {
    const listed = await listChanges(workspace, focus.head);
    if (listed === undefined) return undefined;
    since = listed.paths;
  }
  const ids = required
    .filter(
      (item) =>
        (item.kind === "command" || item.kind === "setup") &&
        item.evidence === undefined &&
        focus.passed.includes(item.id) &&
        matchedPaths(item, since).length === 0,
    )
    .map((item) => item.id);
  const failed = required
    .filter((item) => item.kind === "command" && !focus.passed.includes(item.id))
    .map((item) => item.id);
  return { head: focus.head, ids: new Set(ids), failed: new Set(failed) };
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
  if (item.kind === "preview") {
    return {
      id: item.id,
      kind: item.kind,
      hint: previewRequest(item),
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

async function clean(workspace: string): Promise<boolean> {
  const status = await git(
    workspace,
    ["status", "--porcelain", "--untracked-files=normal"],
    commandEnv(),
  );
  return status.ok && status.stdout.length === 0;
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

type CheckPath = { runtimeBinPaths?: readonly string[]; basePath?: string; bail?: boolean };

function commandEnv({ runtimeBinPaths = [], basePath, bail }: CheckPath = {}): Record<
  string,
  string
> {
  const env: Record<string, string> = {
    ...scrubCommandEnv(),
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  if (basePath !== undefined) env.PATH = basePath;
  if (runtimeBinPaths.length)
    env.PATH = [...runtimeBinPaths, ...(env.PATH ? [env.PATH] : [])].join(delimiter);
  if (bail) env.PAWS_TEST_BAIL = "1";
  return env;
}

const OUTPUT_DRAIN_MS = 1_000;

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
    let drain: ReturnType<typeof setTimeout> | undefined;
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
      clearTimeout(drain);
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
    child.on("exit", (code) => {
      drain = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ code: code ?? 1, timedOut, cancelled, output: output.slice(-6_000) });
      }, OUTPUT_DRAIN_MS);
    });
    if (signal?.aborted) onAbort();
  });
}
