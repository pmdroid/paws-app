import { journalCaught } from "../../journal";
import { checkoutPatterns, exclusionPatterns } from "../../worktree-checkout";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  CandidateIdentity,
  CiResult,
  CommandExec,
  CommandRecord,
  EvidenceRecord,
  EvidenceStore,
  Gate,
  ResolvedCommand,
  ResolvedPolicy,
  ResolvedReview,
  ResolvedRule,
  ResolvedSetup,
} from "../types";
import {
  ciMessage,
  evaluate,
  retryBlock,
  ruleRequirement,
  type RuleRequirement,
} from "../evaluate/evaluate";
import { recheckDigest } from "../policy/canonical";
import { SPEC_VERSION } from "../types";
import {
  changedPaths,
  createCommandRunner,
  git,
  isSha,
  pawsHome,
  resolveCommit,
  type PawsCommandRunner,
} from "./exec";
import { credentialSecrets, scrubCommandEnv } from "./env";
import { withRetryLock } from "./lock";
import { matchPaths } from "./paths";
import {
  createProbeRunner,
  PROBE_TIMEOUT_SECONDS,
  probeArgv,
  probeArtifactPath,
  probeSha256,
  type ProbeRunner,
} from "./probe";
import type { CloseoutProgress, CloseoutProgressIdentity, CloseoutProgressStep } from "./progress";
import { scrubText } from "./scrub";

/** Identity written on every command record this runner stores. */
export const PAWS_CLOSEOUT_PRODUCER = {
  name: "paws-closeout",
  version: "0.1.0",
} as const;

/**
 * Runs setup steps and commands. Rule probes run through its `runProbe` when it has one, and
 * otherwise on this machine against the trusted worktree of the candidate.
 */
export type CloseoutCommandPort = Pick<PawsCommandRunner, "runLogged"> & Partial<ProbeRunner>;

export type CommandDisposition = {
  id: string;
  kind: string;
  state: "ran" | "skipped" | "exhausted";
  message: string;
};

export type CloseoutRunResult = {
  /**
   * Set when the runner refuses to execute. A changed-path failure starts
   * with `changed paths are unavailable`.
   */
  blocked?: string;
  dispositions: CommandDisposition[];
};

export type CloseoutRunInput = {
  checkoutExclusions?: readonly string[];
  /** Agent checkout. Policy commands are never started with this as `cwd`. */
  repo: string;
  policy: ResolvedPolicy;
  base: string;
  head: string;
  candidate: CandidateIdentity;
  evidence: EvidenceStore;
  /** Records, logs, and the retry lock live here. */
  evidenceDir: string;
  /** `~/.paws` override. Detached worktrees are created under `<home>/closeout/tmp`. */
  home?: string;
  gate?: Gate;
  /** Parent environment for setup steps and commands. Credentials are removed. */
  env?: NodeJS.ProcessEnv;
  progress?: CloseoutProgress;
  /**
   * Runs setup steps and commands. Probes run on this machine unless it has `runProbe`, so a
   * remote runner that only runs commands still gets every in-scope rule judged.
   */
  commandRunner?: CloseoutCommandPort;
  retryBaseline?: readonly string[];
  /**
   * Command checks whose result comes from green CI at `head`. Each is recorded as passed with
   * its CI run instead of running. Setup steps, rules and other commands run as usual.
   */
  fromCi?: readonly CiResult[];
};

type Runnable = ResolvedSetup | ResolvedCommand;

let worktreeSequence = 0;

/**
 * Run in-scope setup steps, then in-scope commands, in a detached worktree
 * of the candidate head. Command records are handed to `evidence`.
 */
export async function runCloseoutCommands(raw: CloseoutRunInput): Promise<CloseoutRunResult> {
  const input: CloseoutRunInput = {
    ...raw,
    progress: scrubProgress(raw.progress, raw.env),
  };
  if (input.policy.source === "none") return { dispositions: [] };
  const taskError = taskRetryError(input.policy, input.candidate);
  if (taskError !== null) return { blocked: taskError, dispositions: [] };

  const env = scrubCommandEnv(input.env);
  const gate = input.gate ?? "beforePR";
  const base = await resolveRev(input.repo, input.base, env);
  const head = await resolveRev(input.repo, input.head, env);
  if (base === null || head === null) {
    return { blocked: "base or head does not resolve to a commit", dispositions: [] };
  }

  return withRetryLock(input.evidenceDir, true, async () => {
    const snapshot = await input.evidence.load();
    if (snapshot.invalid !== undefined) {
      return { blocked: snapshot.invalid.message, dispositions: [] };
    }
    const records = [...snapshot.records];
    const needed = needsChangedPaths(input.policy, gate);
    let changed: string[] | null = null;
    if (needed) {
      const diff = await changedPaths(input.repo, base, head, env);
      if (!diff.ok) return { blocked: diff.message, dispositions: [] };
      changed = diff.paths;
    }

    const evaluated = evaluate(input.policy, records, {
      base,
      head,
      gate,
      candidate: input.candidate,
      changedPaths: changed,
      ...(input.retryBaseline !== undefined ? { retryBaseline: input.retryBaseline } : {}),
    });
    if (evaluated.items.some((item) => item.kind === "review" && item.state === "exhausted")) {
      return { dispositions: [] };
    }

    const steps = input.policy.setup.filter((step) => step.gate === gate);
    const commands = input.policy.items.filter(isCommand).filter((item) => item.gate === gate);
    const reviews = input.policy.items.filter(isReview).filter((item) => item.gate === gate);
    const actions = [
      // Rules first, so the probes see the pristine checkout and not files a setup step left.
      ...classifyRules(gate, changed, input, base, head, records),
      ...classifyAll(steps, commands, changed, input, base, head, records),
    ];
    const identity = progressIdentity(input, base, head);
    publishPlan(input.progress, identity, actions, reviews);
    const fromCi: CommandDisposition[] = [];
    for (const action of actions) {
      if (action.kind !== "ci") continue;
      await recordFromCi(
        input,
        action.item,
        action.ci,
        base,
        head,
        records,
        identity,
        ordinalOf(actions, action.item.id),
      );
      fromCi.push({
        id: action.item.id,
        kind: action.item.kind,
        state: "ran",
        message: ciMessage(action.ci),
      });
    }
    if (actions.every((action) => action.kind === "skip" || action.kind === "ci")) {
      return { dispositions: [...skips(actions), ...fromCi] };
    }

    const tree = allocateWorktree(pawsHome(input.home));
    const added = await git(
      input.repo,
      ["worktree", "add", "--no-checkout", "--detach", tree, head],
      env,
    );
    if (!added.ok) {
      rmSync(tree, { recursive: true, force: true });
      blockPending(
        input.progress,
        identity,
        actions,
        "could not create a worktree at the candidate commit",
      );
      return { blocked: "could not create a worktree at the candidate commit", dispositions: [] };
    }
    const runner = input.commandRunner ?? createCommandRunner({ env: input.env });
    const probes: ProbeRunner = input.commandRunner?.runProbe
      ? { runProbe: input.commandRunner.runProbe.bind(input.commandRunner) }
      : createProbeRunner({ env: input.env });
    const dispositions: CommandDisposition[] = [...fromCi];
    const unjudged: string[] = [];
    let stop = false;
    try {
      try {
        await checkoutPatterns(tree, exclusionPatterns(input.checkoutExclusions ?? []), env);
      } catch (caughtError1) {
        journalCaught(caughtError1, "run.runCloseoutCommands.checkoutPatterns", null);
        const blocked = "could not populate a worktree at the candidate commit";
        blockPending(input.progress, identity, actions, blocked);
        return { blocked, dispositions: [] };
      }
      for (const action of actions) {
        if (action.kind === "ci") continue;
        if (action.kind === "skip") {
          dispositions.push(action.disposition);
          continue;
        }
        if (action.kind === "rule") {
          const ran = await runRule(
            probes,
            input,
            action.rule,
            tree,
            base,
            head,
            records,
            identity,
            ordinalOf(actions, action.item.id),
          );
          if (typeof ran === "string") unjudged.push(`rule ${action.rule.id}: ${ran}`);
          dispositions.push({
            id: action.rule.id,
            kind: "rule",
            state: "ran",
            message: typeof ran === "string" ? ran : execMessage(ran, false),
          });
          continue;
        }
        if (stop) {
          const skipped = {
            id: action.item.id,
            kind: action.item.kind,
            state: "skipped" as const,
            message: "setup failed",
          };
          dispositions.push(skipped);
          input.progress?.step(
            identity,
            stepUpdate(action.item, skipped, ordinalOf(actions, action.item.id), null),
          );
          continue;
        }
        let exec = await runOne(
          runner,
          input,
          action.item,
          tree,
          base,
          head,
          records,
          identity,
          ordinalOf(actions, action.item.id),
        );
        if (
          action.item.kind === "setup" &&
          executionFailed(exec, true) &&
          !retryBlock(
            action.item,
            input.policy.source === "none" ? undefined : input.policy.retry,
            input.policy.digest ?? "",
            records,
            { base, head, gate, candidate: input.candidate, retryBaseline: input.retryBaseline },
            undefined,
          )
        ) {
          exec = await runOne(
            runner,
            input,
            action.item,
            tree,
            base,
            head,
            records,
            identity,
            ordinalOf(actions, action.item.id),
          );
        }
        dispositions.push({
          id: action.item.id,
          kind: action.item.kind,
          state: "ran",
          message: execMessage(exec, action.item.kind === "setup"),
        });
        if (action.item.kind === "setup" && executionFailed(exec, true)) stop = true;
      }
    } finally {
      await git(input.repo, ["worktree", "remove", "--force", tree], env);
      rmSync(tree, { recursive: true, force: true });
    }
    // A rule without a result would only read as missing, so the reason blocks instead.
    if (unjudged.length > 0) return { blocked: unjudged.join("; "), dispositions };
    return { dispositions };
  });
}

type Action =
  | { kind: "run"; item: Runnable }
  | { kind: "ci"; item: Runnable; ci: CiResult }
  | { kind: "rule"; item: Runnable; rule: ResolvedRule }
  | { kind: "skip"; item: Runnable; disposition: CommandDisposition };

/**
 * Rules in scope at the `beforePR` gate. A rule runs whether or not setup passed: its probe does
 * not use the candidate's dependencies.
 */
function classifyRules(
  gate: Gate,
  changed: readonly string[] | null,
  input: CloseoutRunInput,
  base: string,
  head: string,
  records: EvidenceRecord[],
): Action[] {
  if (gate !== "beforePR" || input.policy.source === "none") return [];
  return (input.policy.rules ?? []).map((rule) => {
    const item = ruleStep(rule, base, head);
    const decision = classify(ruleRequirement(rule), changed, false, input, base, head, records);
    if (decision.kind === "skip")
      return { kind: "skip", item, disposition: { ...decision.disposition, kind: "rule" } };
    return { kind: "rule", item, rule };
  });
}

/** A rule as a progress step. Rules have no step kind of their own yet. */
function ruleStep(rule: ResolvedRule, base: string, head: string): ResolvedCommand {
  return {
    id: rule.id,
    kind: "command",
    gate: "beforePR",
    exec: probeArgv(rule, base, head),
    timeoutSeconds: PROBE_TIMEOUT_SECONDS,
  };
}

function classifyAll(
  steps: readonly ResolvedSetup[],
  commands: readonly ResolvedCommand[],
  changed: readonly string[] | null,
  input: CloseoutRunInput,
  base: string,
  head: string,
  records: EvidenceRecord[],
): Action[] {
  const actions: Action[] = [];
  let stop = false;
  for (const item of [...steps, ...commands]) {
    const decision = classify(item, changed, stop, input, base, head, records);
    const ci =
      item.kind === "command" && item.ci !== undefined
        ? input.fromCi?.find((entry) => entry.id === item.id)
        : undefined;
    if (decision.kind === "run" && ci !== undefined) actions.push({ kind: "ci", item, ci });
    else if (decision.kind === "run") actions.push({ kind: "run", item });
    else actions.push({ kind: "skip", item, disposition: decision.disposition });
    if (decision.stop) stop = true;
  }
  return actions;
}

function skips(actions: readonly Action[]): CommandDisposition[] {
  const dispositions: CommandDisposition[] = [];
  for (const action of actions) {
    if (action.kind === "skip") dispositions.push(action.disposition);
  }
  return dispositions;
}

type Classified =
  | { kind: "run"; stop: false }
  | { kind: "skip"; stop: boolean; disposition: CommandDisposition };

function classify(
  item: Runnable | RuleRequirement,
  changed: readonly string[] | null,
  setupStopped: boolean,
  input: CloseoutRunInput,
  base: string,
  head: string,
  records: EvidenceRecord[],
): Classified {
  if (!inScope(item, changed)) {
    return {
      kind: "skip",
      stop: false,
      disposition: {
        id: item.id,
        kind: item.kind,
        state: "skipped",
        message: "no changed path matches",
      },
    };
  }
  if (setupStopped) {
    return {
      kind: "skip",
      stop: false,
      disposition: { id: item.id, kind: item.kind, state: "skipped", message: "setup failed" },
    };
  }
  const blocked = retryBlock(
    item,
    input.policy.source === "none" ? undefined : input.policy.retry,
    input.policy.digest ?? "",
    records,
    {
      base,
      head,
      gate: input.gate ?? "beforePR",
      candidate: input.candidate,
      ...(input.retryBaseline !== undefined ? { retryBaseline: input.retryBaseline } : {}),
    },
    undefined,
  );
  if (blocked !== undefined) {
    return {
      kind: "skip",
      stop: item.kind === "setup",
      disposition: {
        id: item.id,
        kind: item.kind,
        state: blocked.state === "exhausted" ? "exhausted" : "skipped",
        message: blocked.message,
      },
    };
  }
  return { kind: "run", stop: false };
}

async function runOne(
  runner: Pick<PawsCommandRunner, "runLogged">,
  input: CloseoutRunInput,
  item: Runnable,
  cwd: string,
  base: string,
  head: string,
  records: EvidenceRecord[],
  identity: CloseoutProgressIdentity,
  ordinal: number,
): Promise<CommandExec> {
  const digest = input.policy.digest ?? "";
  const attempt = nextAttempt(records, item.id, head, digest);
  const relative = artifactRelative(digest, head, item.id, attempt);
  const startedAt = Date.now();
  input.progress?.step(identity, {
    ...blankStep(item, ordinal),
    state: "running",
    attempt,
    startedAt,
    logPath: relative,
    evidencePath: evidenceRelative(digest, head, item.id, attempt),
  });
  const exec = await runner.runLogged({
    cwd,
    itemId: item.id,
    argv: item.exec,
    timeoutSeconds: item.timeoutSeconds,
    logFile: join(input.evidenceDir, ...relative.split("/")),
    artifactPath: relative,
    expectedHead: head,
    onOutput: (stream, text, truncated) => {
      input.progress?.output(identity, item.id, stream, text, truncated);
    },
  });
  const task = input.candidate.task;
  const record: CommandRecord = {
    specVersion: SPEC_VERSION,
    recordType: "command",
    ...(task !== undefined && task.length > 0 ? { task } : {}),
    itemId: item.id,
    base,
    head,
    policyDigest: digest,
    attempt,
    evaluator: { name: PAWS_CLOSEOUT_PRODUCER.name, version: PAWS_CLOSEOUT_PRODUCER.version },
    producer: { name: PAWS_CLOSEOUT_PRODUCER.name, version: PAWS_CLOSEOUT_PRODUCER.version },
    exec: {
      argv: item.exec,
      exitCode: exec.exitCode,
      timedOut: exec.timedOut,
      dirty: exec.dirty,
      headMoved: exec.headMoved,
      durationMs: exec.durationMs,
      truncated: exec.truncated,
    },
    artifacts: exec.artifacts,
  };
  await input.evidence.add(record);
  records.push(record);
  const failed = executionFailed(record.exec, item.kind === "setup");
  input.progress?.step(identity, {
    ...blankStep(item, ordinal),
    state: failed ? "failed" : "passed",
    detail: execMessage(record.exec, item.kind === "setup"),
    attempt,
    startedAt,
    finishedAt: startedAt + exec.durationMs,
    exitCode: record.exec.exitCode,
    timedOut: record.exec.timedOut,
    timeoutReason: record.exec.timedOut ? "command timed out" : null,
    truncated: record.exec.truncated,
    logPath: relative,
    evidencePath: evidenceRelative(digest, head, item.id, attempt),
  });
  return record.exec;
}

/**
 * Store a passing command record for `item` taken from green CI at `head`: its argv is the
 * policy's, nothing ran, and `ci` names the run and the checks it came from.
 */
async function recordFromCi(
  input: CloseoutRunInput,
  item: Runnable,
  ci: CiResult,
  base: string,
  head: string,
  records: EvidenceRecord[],
  identity: CloseoutProgressIdentity,
  ordinal: number,
): Promise<void> {
  const digest = input.policy.digest ?? "";
  const attempt = nextAttempt(records, item.id, head, digest);
  const task = input.candidate.task;
  const record: CommandRecord = {
    specVersion: SPEC_VERSION,
    recordType: "command",
    ...(task !== undefined && task.length > 0 ? { task } : {}),
    itemId: item.id,
    base,
    head,
    policyDigest: digest,
    attempt,
    evaluator: { name: PAWS_CLOSEOUT_PRODUCER.name, version: PAWS_CLOSEOUT_PRODUCER.version },
    producer: { name: PAWS_CLOSEOUT_PRODUCER.name, version: PAWS_CLOSEOUT_PRODUCER.version },
    exec: {
      argv: item.exec,
      exitCode: 0,
      timedOut: false,
      dirty: false,
      headMoved: false,
      durationMs: 0,
      truncated: false,
    },
    artifacts: [],
    ci: { run: ci.run, checks: ci.checks.map((check) => ({ ...check })) },
  };
  await input.evidence.add(record);
  records.push(record);
  const now = Date.now();
  input.progress?.step(identity, {
    ...blankStep(item, ordinal),
    state: "passed",
    detail: ciMessage(ci),
    attempt,
    startedAt: now,
    finishedAt: now,
    exitCode: 0,
    evidencePath: evidenceRelative(digest, head, item.id, attempt),
  });
}

/**
 * Run one rule's probe and store its result as a command record. The record's argv is
 * {@link probeArgv}, and its artifacts are the log and the probe that ran, named by that probe's
 * hash. When the probe has no result, nothing is stored and the reason is returned.
 */
async function runRule(
  probes: ProbeRunner,
  input: CloseoutRunInput,
  rule: ResolvedRule,
  checkout: string,
  base: string,
  head: string,
  records: EvidenceRecord[],
  identity: CloseoutProgressIdentity,
  ordinal: number,
): Promise<CommandExec | string> {
  const digest = input.policy.digest ?? "";
  const step = ruleStep(rule, base, head);
  const attempt = nextAttempt(records, rule.id, head, digest);
  const relative = artifactRelative(digest, head, rule.id, attempt);
  const startedAt = Date.now();
  input.progress?.step(identity, {
    ...blankStep(step, ordinal),
    state: "running",
    attempt,
    startedAt,
    logPath: relative,
    evidencePath: evidenceRelative(digest, head, rule.id, attempt),
  });
  const bytes =
    input.policy.source === "none" ? undefined : input.policy.probeFiles?.get(rule.probe);
  let ran: Awaited<ReturnType<ProbeRunner["runProbe"]>>;
  let reason =
    bytes === undefined
      ? "the policy carries no bytes for it"
      : "the probe runner returned nothing";
  try {
    ran = await probes.runProbe({
      rule,
      bytes,
      base,
      head,
      checkout,
      argv: step.exec,
      timeoutSeconds: PROBE_TIMEOUT_SECONDS,
      logFile: join(input.evidenceDir, ...relative.split("/")),
      artifactPath: relative,
      onOutput: (stream, text, truncated) => {
        input.progress?.output(identity, rule.id, stream, text, truncated);
      },
    });
  } catch (caughtError) {
    journalCaught(caughtError, "run.runRule.runProbe", rule.id);
    ran = undefined;
    reason = caughtError instanceof Error ? caughtError.message : String(caughtError);
  }
  if (ran === undefined) {
    const detail = scrubText(
      `probe ${rule.probe} could not run: ${reason}`,
      credentialSecrets(input.env),
    );
    input.progress?.step(identity, {
      ...blankStep(step, ordinal),
      state: "blocked",
      detail,
      finishedAt: Date.now(),
    });
    return detail;
  }
  const probe = probeArtifactPath(ran.probeSha256, rule.probe);
  if (bytes !== undefined && probeSha256(bytes) === ran.probeSha256) {
    const file = join(input.evidenceDir, ...probe.split("/"));
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, bytes, { mode: 0o600 });
  }
  const task = input.candidate.task;
  const record: CommandRecord = {
    specVersion: SPEC_VERSION,
    recordType: "command",
    ...(task !== undefined && task.length > 0 ? { task } : {}),
    itemId: rule.id,
    base,
    head,
    policyDigest: digest,
    attempt,
    evaluator: { name: PAWS_CLOSEOUT_PRODUCER.name, version: PAWS_CLOSEOUT_PRODUCER.version },
    producer: { name: PAWS_CLOSEOUT_PRODUCER.name, version: PAWS_CLOSEOUT_PRODUCER.version },
    exec: {
      argv: ran.argv,
      exitCode: ran.exitCode,
      timedOut: ran.timedOut,
      dirty: ran.dirty,
      headMoved: ran.headMoved,
      durationMs: ran.durationMs,
      truncated: ran.truncated,
    },
    artifacts: [...ran.artifacts.slice(0, 15), { path: probe, sha256: ran.probeSha256 }],
  };
  await input.evidence.add(record);
  records.push(record);
  input.progress?.step(identity, {
    ...blankStep(step, ordinal),
    state: executionFailed(record.exec, false) ? "failed" : "passed",
    detail: execMessage(record.exec, false),
    attempt,
    startedAt,
    finishedAt: startedAt + ran.durationMs,
    exitCode: record.exec.exitCode,
    timedOut: record.exec.timedOut,
    timeoutReason: record.exec.timedOut ? "command timed out" : null,
    truncated: record.exec.truncated,
    logPath: relative,
    evidencePath: evidenceRelative(digest, head, rule.id, attempt),
  });
  return record.exec;
}

function needsChangedPaths(policy: ResolvedPolicy, gate: Gate): boolean {
  const setup = policy.setup.some((step) => step.gate === gate && hasPaths(step));
  const items = policy.items.some((item) => item.gate === gate && hasPaths(item));
  const rules =
    gate === "beforePR" && policy.source !== "none" && (policy.rules ?? []).some(hasPaths);
  return setup || items || rules;
}

function inScope(item: { paths?: string[] }, changed: readonly string[] | null): boolean {
  if (!hasPaths(item)) return true;
  if (changed === null) return false;
  return matchPaths(item.paths ?? [], changed);
}

function hasPaths(item: { paths?: string[] }): boolean {
  return item.paths !== undefined && item.paths.length > 0;
}

function isCommand(item: ResolvedPolicy["items"][number]): item is ResolvedCommand {
  return item.kind === "command" && !("supported" in item);
}

function isReview(item: ResolvedPolicy["items"][number]): item is ResolvedReview {
  return item.kind === "review" && !("supported" in item);
}

function scrubProgress(
  progress: CloseoutProgress | undefined,
  env: NodeJS.ProcessEnv | undefined,
): CloseoutProgress | undefined {
  if (progress === undefined) return undefined;
  const secrets = credentialSecrets(env);
  const text = (value: string): string => scrubText(value, secrets);
  const optional = (value: string | null): string | null => (value === null ? null : text(value));
  return {
    begin(identity) {
      progress.begin(identity);
    },
    step(identity, step) {
      progress.step(identity, {
        ...step,
        command: text(step.command),
        detail: optional(step.detail),
        timeoutReason: optional(step.timeoutReason),
        findings: optional(step.findings),
      });
    },
    output(identity, stepId, stream, chunk, truncated) {
      progress.output(identity, stepId, stream, text(chunk), truncated);
    },
    finish(identity, decision) {
      progress.finish(identity, decision);
    },
  };
}

function progressIdentity(
  input: CloseoutRunInput,
  base: string,
  head: string,
): CloseoutProgressIdentity {
  return {
    taskId: input.candidate.task ?? "",
    base,
    head,
    policyDigest: input.policy.digest ?? "",
    policyPath: input.policy.source === "none" ? null : input.policy.entryPath,
    recheckDigest: input.policy.source === "none" ? "" : recheckDigest(input.policy),
  };
}

function publishPlan(
  progress: CloseoutProgress | undefined,
  identity: CloseoutProgressIdentity,
  actions: readonly Action[],
  reviews: readonly ResolvedReview[],
): void {
  if (progress === undefined) return;
  progress.begin(identity);
  actions.forEach((action, ordinal) => {
    if (action.kind === "skip") {
      progress.step(identity, stepUpdate(action.item, action.disposition, ordinal, null));
      return;
    }
    progress.step(identity, { ...blankStep(action.item, ordinal), state: "pending" });
  });
  reviews.forEach((item, index) => {
    progress.step(identity, {
      ...blankStep(
        {
          id: item.id,
          kind: "review",
          exec: [],
          timeoutSeconds: 0,
        },
        actions.length + index,
      ),
      kind: "review",
      command: item.skill,
      timeoutSeconds: null,
      state: "pending",
    });
  });
}

function blockPending(
  progress: CloseoutProgress | undefined,
  identity: CloseoutProgressIdentity,
  actions: readonly Action[],
  detail: string,
): void {
  if (progress === undefined) return;
  for (const action of actions) {
    if (action.kind === "skip" || action.kind === "ci") continue;
    progress.step(identity, {
      ...blankStep(action.item, ordinalOf(actions, action.item.id)),
      state: "blocked",
      detail,
      finishedAt: Date.now(),
    });
  }
}

function ordinalOf(actions: readonly Action[], id: string): number {
  const index = actions.findIndex((action) => action.item.id === id);
  return index < 0 ? 0 : index;
}

function stepUpdate(
  item: Runnable,
  disposition: CommandDisposition,
  ordinal: number,
  attempt: number | null,
): CloseoutProgressStep {
  const state = disposition.state === "exhausted" ? "exhausted" : "skipped";
  return {
    ...blankStep(item, ordinal),
    state,
    detail: disposition.message,
    attempt: attempt ?? 0,
    finishedAt: Date.now(),
  };
}

function blankStep(
  item: { id: string; kind: string; exec?: readonly string[]; timeoutSeconds?: number },
  ordinal: number,
): CloseoutProgressStep {
  const kind = item.kind === "setup" || item.kind === "review" ? item.kind : "command";
  return {
    id: item.id,
    kind,
    state: "pending",
    command: item.exec && item.exec.length > 0 ? item.exec.join(" ") : item.id,
    detail: null,
    attempt: 0,
    timeoutSeconds: item.timeoutSeconds && item.timeoutSeconds > 0 ? item.timeoutSeconds : null,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    timedOut: false,
    timeoutReason: null,
    truncated: false,
    logPath: null,
    evidencePath: null,
    findings: null,
    ordinal,
  };
}

function taskRetryError(policy: ResolvedPolicy, candidate: CandidateIdentity): string | null {
  if (policy.source === "none") return null;
  const task = candidate.task ?? "";
  if (
    policy.retry?.scope === "task" &&
    (task.trim().length === 0 || Buffer.byteLength(task) > 256)
  ) {
    return "task retry scope requires a stable task id";
  }
  if (task.length > 0 && (task.trim().length === 0 || Buffer.byteLength(task) > 256)) {
    return "task id must contain 1 to 256 bytes";
  }
  return null;
}

function executionFailed(exec: CommandExec, setup: boolean): boolean {
  if (exec.timedOut) return true;
  if (exec.exitCode === null || exec.exitCode !== 0) return true;
  if (exec.headMoved) return true;
  if (!setup && exec.dirty) return true;
  return false;
}

function execMessage(exec: CommandExec, setup: boolean): string {
  if (exec.timedOut) return "command timed out";
  if (exec.exitCode === null) return "command could not start";
  if (exec.exitCode !== 0) return `command exited ${exec.exitCode}`;
  if (exec.headMoved) return "command moved HEAD";
  if (exec.dirty && !setup) return "command left the worktree dirty";
  return "exited 0";
}

function nextAttempt(
  records: readonly EvidenceRecord[],
  itemId: string,
  head: string,
  digest: string,
): number {
  let max = 0;
  for (const record of records) {
    if (record.itemId !== itemId || record.head !== head || record.policyDigest !== digest)
      continue;
    if (record.attempt > max) max = record.attempt;
  }
  return max + 1;
}

function artifactRelative(digest: string, head: string, itemId: string, attempt: number): string {
  const hex = digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
  return ["logs", hex, head, ...itemId.split("/"), `${attempt}.log`].join("/");
}

function evidenceRelative(digest: string, head: string, itemId: string, attempt: number): string {
  const hex = digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
  return ["evidence", hex, head, ...itemId.split("/"), `${attempt}.json`].join("/");
}

async function resolveRev(
  repo: string,
  rev: string,
  env: Record<string, string>,
): Promise<string | null> {
  const sha = await resolveCommit(repo, rev, env);
  if (sha === null || !isSha(sha)) return null;
  return sha;
}

function allocateWorktree(home: string): string {
  worktreeSequence += 1;
  const root = join(home, "closeout", "tmp");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return join(root, `wt-${process.pid}-${worktreeSequence}-${Date.now()}`);
}
