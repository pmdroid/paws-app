import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  CandidateIdentity,
  CommandExec,
  CommandRecord,
  EvidenceRecord,
  EvidenceStore,
  Gate,
  ResolvedCommand,
  ResolvedPolicy,
  ResolvedSetup,
} from "../types";
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
import { scrubCommandEnv } from "./env";
import { withRetryLock } from "./lock";
import { matchPaths } from "./paths";

/** Identity written on every command record this runner stores. */
export const PAWS_CLOSEOUT_PRODUCER = {
  name: "paws-closeout",
  version: "0.1.0",
} as const;

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
};

type Runnable = ResolvedSetup | ResolvedCommand;

let worktreeSequence = 0;

/**
 * Run in-scope setup steps, then in-scope commands, in a detached worktree
 * of the candidate head. Command records are handed to `evidence`.
 */
export async function runCloseoutCommands(input: CloseoutRunInput): Promise<CloseoutRunResult> {
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

  return withRetryLock(input.evidenceDir, input.policy.retry !== undefined, async () => {
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

    const steps = input.policy.setup.filter((step) => step.gate === gate);
    const commands = input.policy.items.filter(isCommand).filter((item) => item.gate === gate);
    const actions = classifyAll(steps, commands, changed, input, base, head, records);
    if (!actions.some((action) => action.kind === "run")) {
      return { dispositions: skips(actions) };
    }

    const tree = allocateWorktree(pawsHome(input.home));
    const added = await git(input.repo, ["worktree", "add", "--detach", tree, head], env);
    if (!added.ok) {
      rmSync(tree, { recursive: true, force: true });
      return { blocked: "could not create a worktree at the candidate commit", dispositions: [] };
    }
    const runner = createCommandRunner({ env: input.env });
    const dispositions: CommandDisposition[] = [];
    let stop = false;
    try {
      for (const action of actions) {
        if (action.kind === "skip") {
          dispositions.push(action.disposition);
          continue;
        }
        if (stop) {
          dispositions.push({
            id: action.item.id,
            kind: action.item.kind,
            state: "skipped",
            message: "setup failed",
          });
          continue;
        }
        const exec = await runOne(runner, input, action.item, tree, base, head, records);
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
    return { dispositions };
  });
}

type Action = { kind: "run"; item: Runnable } | { kind: "skip"; disposition: CommandDisposition };

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
    if (decision.kind === "run") actions.push({ kind: "run", item });
    else actions.push({ kind: "skip", disposition: decision.disposition });
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
  item: Runnable,
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
  const blocked = retryBlock(input.policy, item, base, head, input.candidate, records);
  if (blocked !== null) {
    return {
      kind: "skip",
      stop: item.kind === "setup",
      disposition: {
        id: item.id,
        kind: item.kind,
        state: blocked.startsWith("duplicate") ? "skipped" : "exhausted",
        message: blocked,
      },
    };
  }
  return { kind: "run", stop: false };
}

async function runOne(
  runner: PawsCommandRunner,
  input: CloseoutRunInput,
  item: Runnable,
  cwd: string,
  base: string,
  head: string,
  records: EvidenceRecord[],
): Promise<CommandExec> {
  const digest = input.policy.digest ?? "";
  const attempt = nextAttempt(records, item.id, head, digest);
  const relative = artifactRelative(digest, head, item.id, attempt);
  const exec = await runner.runLogged({
    cwd,
    argv: item.exec,
    timeoutSeconds: item.timeoutSeconds,
    logFile: join(input.evidenceDir, ...relative.split("/")),
    artifactPath: relative,
    expectedHead: head,
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
  return record.exec;
}

function needsChangedPaths(policy: ResolvedPolicy, gate: Gate): boolean {
  const setup = policy.setup.some((step) => step.gate === gate && hasPaths(step));
  const items = policy.items.some((item) => item.gate === gate && hasPaths(item));
  return setup || items;
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

function retryBlock(
  policy: ResolvedPolicy,
  item: Runnable,
  base: string,
  head: string,
  candidate: CandidateIdentity,
  records: readonly EvidenceRecord[],
): string | null {
  if (policy.source === "none") return null;
  const retry = policy.retry;
  if (retry === undefined) return null;
  const seen = new Set<string>();
  let failed = 0;
  for (const record of records) {
    if (!inRetryScope(record, retry.scope, item.id, policy.digest, base, head, candidate)) continue;
    const key = `${record.base}\0${record.head}\0${record.attempt}`;
    if (seen.has(key)) return "duplicate evidence attempt";
    seen.add(key);
    if (countsAsFailed(item, record)) failed += 1;
  }
  if (failed < retry.maxFailedAttemptsPerItem) return null;
  return `${failed} of ${retry.maxFailedAttemptsPerItem} allowed failed attempts used. Stop retrying and ask for help.`;
}

function inRetryScope(
  record: EvidenceRecord,
  scope: "task" | "candidate",
  itemId: string,
  digest: string,
  base: string,
  head: string,
  candidate: CandidateIdentity,
): boolean {
  if (record.itemId !== itemId || record.policyDigest !== digest) return false;
  if (scope === "task") {
    const task = candidate.task ?? "";
    return task.length > 0 && record.task === task;
  }
  return record.base === base && record.head === head;
}

function countsAsFailed(item: Runnable, record: EvidenceRecord): boolean {
  if (record.recordType !== "command") return false;
  if (record.producer.name !== PAWS_CLOSEOUT_PRODUCER.name) return false;
  if (record.producer.version !== PAWS_CLOSEOUT_PRODUCER.version) return false;
  if (!sameArgv(record.exec.argv, item.exec)) return false;
  return executionFailed(record.exec, item.kind === "setup");
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

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((arg, index) => arg === right[index]);
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
