import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { CLOSEOUT_OUTPUT_CAP_BYTES } from "./closeout-progress";
import { immediate } from "./tx";

export type AgentCloseoutCheck = {
  id: string;
  kind: string;
  command: string;
  status: string;
  failedAttempts: number;
};

export type AgentCloseoutProgress =
  | {
      type: "report";
      head: string;
      maxAttempts: number | null;
      checks: AgentCloseoutCheck[];
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

export type AgentCloseoutEvent = {
  runId: string;
  itemId: string;
  sequence: number;
  at: number;
  progress: AgentCloseoutProgress;
};

type EventSql = {
  run_id: string;
  item_id: string;
  sequence: number;
  at: number;
  type: AgentCloseoutProgress["type"];
  head: string;
  max_attempts: number | null;
  check_id: string | null;
  kind: string | null;
  command: string | null;
  attempt: number | null;
  state: "passed" | "failed" | "exhausted" | "cancelled" | null;
  exit_code: number | null;
  timed_out: number;
  duration_ms: number | null;
  stdout: string;
  stderr: string;
  truncated: number;
  checks: string | null;
  blocked: string | null;
};

export function recordAgentCloseout(
  db: Database,
  runId: string,
  itemId: string,
  progress: AgentCloseoutProgress,
  now: number,
): void {
  const stdout = progress.type === "finished" ? keepTail(progress.stdout) : null;
  const stderr = progress.type === "finished" ? keepTail(progress.stderr) : null;
  immediate(db, () => {
    const sequence =
      db
        .query<{ last: number | null }, [string]>(
          "SELECT MAX(sequence) AS last FROM agent_closeout_event WHERE run_id = ?",
        )
        .get(runId)!.last ?? 0;
    db.run(
      `INSERT INTO agent_closeout_event (
         run_id, sequence, item_id, at, type, head, max_attempts, check_id, kind, command, attempt,
         state, exit_code, timed_out, duration_ms, stdout, stderr, truncated, checks, blocked
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        sequence + 1,
        itemId,
        now,
        progress.type,
        progress.head,
        progress.maxAttempts,
        progress.type === "report" ? null : progress.id,
        progress.type === "report" ? null : progress.kind,
        progress.type === "report" ? null : progress.command,
        progress.type === "report" ? null : progress.attempt,
        progress.type === "finished" ? progress.state : null,
        progress.type === "finished" ? progress.exitCode : null,
        progress.type === "finished" && progress.timedOut ? 1 : 0,
        progress.type === "finished" ? progress.durationMs : null,
        stdout?.text ?? "",
        stderr?.text ?? "",
        progress.type === "finished" && (progress.truncated || stdout!.cut || stderr!.cut) ? 1 : 0,
        progress.type === "report" ? JSON.stringify(progress.checks) : null,
        progress.type === "report" ? progress.blocked : null,
      ],
    );
  });
}

export function listAgentCloseout(db: Database, runIds: readonly string[]): AgentCloseoutEvent[] {
  if (runIds.length === 0) return [];
  return db
    .query<EventSql, string[]>(
      `SELECT * FROM agent_closeout_event WHERE run_id IN (${runIds.map(() => "?").join(", ")})
       ORDER BY run_id, sequence`,
    )
    .all(...runIds)
    .map(toEvent);
}

function toEvent(row: EventSql): AgentCloseoutEvent {
  const base = { runId: row.run_id, itemId: row.item_id, sequence: row.sequence, at: row.at };
  if (row.type === "report") {
    return {
      ...base,
      progress: {
        type: "report",
        head: row.head,
        maxAttempts: row.max_attempts,
        checks: parseChecks(row.checks),
        blocked: row.blocked,
      },
    };
  }
  const attempt = {
    head: row.head,
    id: row.check_id ?? "",
    kind: row.kind ?? "command",
    command: row.command ?? "",
    attempt: row.attempt ?? 1,
    maxAttempts: row.max_attempts,
  };
  if (row.type === "started") return { ...base, progress: { type: "started", ...attempt } };
  return {
    ...base,
    progress: {
      type: "finished",
      ...attempt,
      state: row.state ?? "failed",
      exitCode: row.exit_code,
      timedOut: row.timed_out === 1,
      durationMs: row.duration_ms ?? 0,
      stdout: row.stdout,
      stderr: row.stderr,
      truncated: row.truncated === 1,
    },
  };
}

function parseChecks(text: string | null): AgentCloseoutCheck[] {
  if (text === null) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as AgentCloseoutCheck[]) : [];
  } catch (caughtError1) {
    journalCaught(caughtError1, "agent-closeout.parseChecks.parse", null);
    return [];
  }
}

function keepTail(text: string): { text: string; cut: boolean } {
  const bytes = Buffer.from(text);
  if (bytes.length <= CLOSEOUT_OUTPUT_CAP_BYTES) return { text, cut: false };
  let start = bytes.length - CLOSEOUT_OUTPUT_CAP_BYTES;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return { text: bytes.subarray(start).toString("utf8"), cut: true };
}
