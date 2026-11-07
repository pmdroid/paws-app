import type { Database } from "bun:sqlite";
import { asc, eq, inArray, max } from "drizzle-orm";
import { journalCaught } from "../journal";
import { CLOSEOUT_OUTPUT_CAP_BYTES } from "./closeout-progress";
import { settled, sqliteDb, type Q } from "./db";
import type * as pgSchema from "./schema-pg";

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
      base?: string;
      policyDigest?: string;
      clean?: boolean;
    };

export type AgentCloseoutEvent = {
  runId: string;
  itemId: string;
  sequence: number;
  at: number;
  progress: AgentCloseoutProgress;
};

type EventRow = typeof pgSchema.agentCloseoutEvent.$inferSelect;

export function* recordAgentCloseoutSteps(
  q: Q,
  runId: string,
  itemId: string,
  progress: AgentCloseoutProgress,
  now: number,
) {
  const { agentCloseoutEvent: event } = q.t;
  const stdout = progress.type === "finished" ? keepTail(progress.stdout) : null;
  const stderr = progress.type === "finished" ? keepTail(progress.stderr) : null;
  const last = yield* q.one(
    q.orm
      .select({ last: max(event.sequence) })
      .from(event)
      .where(eq(event.runId, runId)),
  );
  yield* q.exec(
    q.orm.insert(event).values({
      runId,
      sequence: (last?.last ?? 0) + 1,
      itemId,
      at: now,
      type: progress.type,
      head: progress.head,
      maxAttempts: progress.maxAttempts,
      checkId: progress.type === "report" ? null : progress.id,
      kind: progress.type === "report" ? null : progress.kind,
      command: progress.type === "report" ? null : progress.command,
      attempt: progress.type === "report" ? null : progress.attempt,
      state: progress.type === "finished" ? progress.state : null,
      exitCode: progress.type === "finished" ? progress.exitCode : null,
      timedOut: progress.type === "finished" && progress.timedOut ? 1 : 0,
      durationMs: progress.type === "finished" ? progress.durationMs : null,
      stdout: stdout?.text ?? "",
      stderr: stderr?.text ?? "",
      truncated:
        progress.type === "finished" && (progress.truncated || stdout!.cut || stderr!.cut) ? 1 : 0,
      checks: progress.type === "report" ? JSON.stringify(progress.checks) : null,
      blocked: progress.type === "report" ? progress.blocked : null,
      base: progress.type === "finished" ? (progress.base ?? null) : null,
      policyDigest: progress.type === "finished" ? (progress.policyDigest ?? null) : null,
      clean:
        progress.type === "finished" && progress.clean !== undefined
          ? Number(progress.clean)
          : null,
    }),
  );
}

export function recordAgentCloseout(
  db: Database,
  runId: string,
  itemId: string,
  progress: AgentCloseoutProgress,
  now: number,
): void {
  settled(
    sqliteDb(db).transaction((q) => recordAgentCloseoutSteps(q, runId, itemId, progress, now)),
  );
}

export function* listAgentCloseoutSteps(q: Q, runIds: readonly string[]) {
  if (runIds.length === 0) return [];
  const { agentCloseoutEvent: event } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(event)
      .where(inArray(event.runId, [...runIds]))
      .orderBy(asc(event.runId), asc(event.sequence)),
  );
  return rows.map(toEvent);
}

export function listAgentCloseout(db: Database, runIds: readonly string[]): AgentCloseoutEvent[] {
  return settled(sqliteDb(db).run((q) => listAgentCloseoutSteps(q, runIds)));
}

function toEvent(row: EventRow): AgentCloseoutEvent {
  const base = { runId: row.runId, itemId: row.itemId, sequence: row.sequence, at: row.at };
  if (row.type === "report") {
    return {
      ...base,
      progress: {
        type: "report",
        head: row.head,
        maxAttempts: row.maxAttempts,
        checks: parseChecks(row.checks),
        blocked: row.blocked,
      },
    };
  }
  const attempt = {
    head: row.head,
    id: row.checkId ?? "",
    kind: row.kind ?? "command",
    command: row.command ?? "",
    attempt: row.attempt ?? 1,
    maxAttempts: row.maxAttempts,
  };
  if (row.type === "started") return { ...base, progress: { type: "started", ...attempt } };
  return {
    ...base,
    progress: {
      type: "finished",
      ...attempt,
      state: (row.state ?? "failed") as Extract<
        AgentCloseoutProgress,
        { type: "finished" }
      >["state"],
      exitCode: row.exitCode,
      timedOut: row.timedOut === 1,
      durationMs: row.durationMs ?? 0,
      stdout: row.stdout,
      stderr: row.stderr,
      truncated: row.truncated === 1,
      ...(row.base !== null ? { base: row.base } : {}),
      ...(row.policyDigest !== null ? { policyDigest: row.policyDigest } : {}),
      ...(row.clean !== null ? { clean: row.clean === 1 } : {}),
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
