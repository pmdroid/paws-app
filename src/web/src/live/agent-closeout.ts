import type { AgentCloseoutEvent } from "../../../db";
import { redactCloseoutText } from "../server/artifact";
import type {
  CheckKind,
  StatusAgentCloseout,
  StatusAgentCloseoutStep,
  StatusCheck,
  StatusCloseoutAttempt,
  VerdictDecision,
} from "../contract";

type Run = {
  attempt: number;
  head: string;
  startedAt: number;
  sequence: number;
  finished?: Extract<AgentCloseoutEvent["progress"], { type: "finished" }> & {
    at: number;
    sequence: number;
  };
};

type Check = { id: string; kind: string; command: string; runs: Run[] };

export function agentCloseoutOf(
  itemId: string,
  runId: string,
  events: readonly AgentCloseoutEvent[],
  nowMs: number,
  env: NodeJS.ProcessEnv,
  endedAtMs: number | null = null,
): StatusAgentCloseout | null {
  const last = events.at(-1);
  if (last === undefined) return null;
  const checks = new Map<string, Check>();
  const check = (id: string, kind: string, command: string): Check => {
    const known = checks.get(id) ?? { id, kind, command, runs: [] };
    if (command) known.command = command;
    checks.set(id, known);
    return known;
  };
  let report: { sequence: number; order: string[]; status: Map<string, string> } | null = null;
  let blocked: string | null = null;
  for (const event of events) {
    const progress = event.progress;
    if (progress.type === "report") {
      for (const entry of progress.checks) check(entry.id, entry.kind, entry.command);
      report = {
        sequence: event.sequence,
        order: progress.checks.map((entry) => entry.id),
        status: new Map(progress.checks.map((entry) => [entry.id, entry.status])),
      };
      blocked = progress.blocked;
      continue;
    }
    const target = check(progress.id, progress.kind, progress.command);
    if (progress.type === "started") {
      target.runs.push({
        attempt: progress.attempt,
        head: progress.head,
        startedAt: event.at,
        sequence: event.sequence,
      });
      continue;
    }
    const open = target.runs.at(-1);
    const finished = { ...progress, at: event.at, sequence: event.sequence };
    if (open && open.finished === undefined) open.finished = finished;
    else
      target.runs.push({
        attempt: progress.attempt,
        head: progress.head,
        startedAt: event.at - progress.durationMs,
        sequence: event.sequence,
        finished,
      });
  }
  const order = [
    ...(report?.order ?? []),
    ...[...checks.keys()].filter((id) => !report?.order.includes(id)),
  ].filter((id) => checks.get(id)!.kind !== "review");
  const rounds = Math.max(1, ...order.map((id) => checks.get(id)!.runs.length));
  const attempts: StatusCloseoutAttempt[] = [];
  for (let number = 1; number <= rounds; number += 1) {
    const latest = number === rounds;
    const shown = order.map((id) => {
      const entry = checks.get(id)!;
      const run = entry.runs[Math.min(number, entry.runs.length) - 1];
      const status = report?.status.get(id);
      const stale =
        latest &&
        report !== null &&
        run?.finished !== undefined &&
        report.sequence > run.finished.sequence &&
        (status === "stale" || status === "missing");
      return { entry, run: stale ? undefined : run };
    });
    const runs = shown.flatMap(({ run }) => (run ? [run] : []));
    const current = shown.flatMap(({ entry, run }) =>
      run && entry.runs.indexOf(run) === number - 1 ? [run] : [],
    );
    const head = [...runs].sort((a, b) => b.sequence - a.sequence)[0]?.head ?? "";
    const checksShown = shown.map(({ entry, run }) =>
      entry.kind === "evidence"
        ? evidenceCheck(entry, report?.status.get(entry.id))
        : toCheck(entry, run, nowMs, env, endedAtMs),
    );
    attempts.push({
      number,
      decision: decisionOf(checksShown),
      startedAt: new Date(
        Math.min(...(current.length ? current : runs).map((run) => run.startedAt), last.at),
      ).toISOString(),
      baseSha: null,
      headSha: head || null,
      policyDigest: null,
      checks: checksShown,
    });
  }
  return {
    itemId,
    runId,
    maxAttempts: last.progress.maxAttempts,
    blocked: blocked === null ? null : redactCloseoutText(blocked, env),
    updatedAt: new Date(last.at).toISOString(),
    attempts,
    steps: events.map(stepOf),
  };
}

function toCheck(
  entry: Check,
  run: Run | undefined,
  nowMs: number,
  env: NodeJS.ProcessEnv,
  endedAtMs: number | null,
): StatusCheck {
  const kind = checkKind(entry.kind);
  if (run === undefined)
    return { id: entry.id, kind, state: "pending", command: entry.command, detail: null };
  const done = run.finished;
  if (done === undefined && endedAtMs !== null)
    return {
      id: entry.id,
      kind,
      state: "stopped",
      command: entry.command,
      detail: "Stopped: the run ended before this check finished.",
      attempt: run.attempt,
      elapsedMs: Math.max(0, endedAtMs - run.startedAt),
      active: false,
    };
  if (done === undefined)
    return {
      id: entry.id,
      kind,
      state: "running",
      command: entry.command,
      detail: null,
      attempt: run.attempt,
      elapsedMs: Math.max(0, nowMs - run.startedAt),
      active: true,
    };
  return {
    id: entry.id,
    kind,
    state: done.state === "cancelled" ? "pending" : done.state,
    command: entry.command,
    detail: done.state === "cancelled" ? "The agent's run was cancelled." : null,
    attempt: run.attempt,
    elapsedMs: done.durationMs,
    exitCode: done.exitCode !== null && done.exitCode >= 0 ? done.exitCode : null,
    timedOut: done.timedOut,
    stdout: redactCloseoutText(done.stdout, env),
    stderr: redactCloseoutText(done.stderr, env),
    truncated: done.truncated,
  };
}

function checkKind(kind: string): CheckKind {
  return kind === "setup" || kind === "review" || kind === "evidence" ? kind : "command";
}

function evidenceCheck(entry: Check, status: string | undefined): StatusCheck {
  return {
    id: entry.id,
    kind: "evidence",
    state: status === "passed" ? "passed" : "pending",
    command: entry.command,
    detail: null,
  };
}

function decisionOf(checks: readonly StatusCheck[]): VerdictDecision {
  if (checks.some((check) => check.state === "running")) return "running";
  if (checks.some((check) => check.state === "exhausted")) return "exhausted";
  if (checks.some((check) => check.state === "failed")) return "rejected";
  if (checks.length > 0 && checks.every((check) => check.state === "passed")) return "accepted";
  return "running";
}

function stepOf(event: AgentCloseoutEvent): StatusAgentCloseoutStep {
  const progress = event.progress;
  const at = new Date(event.at).toISOString();
  const headSha = progress.head || null;
  if (progress.type === "report")
    return { at, tool: "get_closeout", checkId: null, state: "reported", attempt: null, headSha };
  return {
    at,
    tool: "run_closeout",
    checkId: progress.id,
    state: progress.type === "started" ? "running" : progress.state,
    attempt: progress.attempt,
    headSha,
  };
}
