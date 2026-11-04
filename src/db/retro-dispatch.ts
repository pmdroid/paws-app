import type { Database } from "bun:sqlite";
import { immediate } from "./tx";
import { ulid } from "./ulid";

export const newRetroCommandId = (now: number): string => ulid(now);

export type RetroDispatchRelease = "result" | "not_started" | "teardown";

export type RetroGenerationDiagnostic =
  | "no_runner"
  | "capacity_wait"
  | "quota_cooldown"
  | "dispatched"
  | "active"
  | "unknown_outcome"
  | "retry_backoff"
  | "failed"
  | "ready";

export const RETRO_WAIT_DIAGNOSTICS: readonly RetroGenerationDiagnostic[] = [
  "no_runner",
  "capacity_wait",
  "quota_cooldown",
];

export type RetroDispatch = {
  commandId: string;
  retroId: string;
  attempt: number;
  workspaceId: string;
  runnerId: string;
  runnerFence: number;
  command: unknown;
  envelope: unknown;
  deliveries: number;
  createdAt: number;
  issuedAt: number;
  expiresAt: number;
  fetchedAt: number | null;
  acknowledgedAt: number | null;
  cancelRequestedAt: number | null;
  result: unknown;
  resultAt: number | null;
  releasedAt: number | null;
  releaseReason: RetroDispatchRelease | null;
  settledAt: number | null;
};

export type RetroGenerationRow = {
  retroId: string;
  diagnostic: RetroGenerationDiagnostic;
  detail: string;
  since: number;
  until: number | null;
  waitMs: number;
  activeMs: number;
  updatedAt: number;
};

type DispatchRow = {
  command_id: string;
  retro_id: string;
  attempt: number;
  workspace_id: string;
  runner_id: string;
  runner_fence: number;
  command: string;
  envelope: string;
  deliveries: number;
  created_at: number;
  issued_at: number;
  expires_at: number;
  fetched_at: number | null;
  acknowledged_at: number | null;
  cancel_requested_at: number | null;
  result: string | null;
  result_at: number | null;
  released_at: number | null;
  release_reason: RetroDispatchRelease | null;
  settled_at: number | null;
};

function fromRow(row: DispatchRow): RetroDispatch {
  return {
    commandId: row.command_id,
    retroId: row.retro_id,
    attempt: row.attempt,
    workspaceId: row.workspace_id,
    runnerId: row.runner_id,
    runnerFence: row.runner_fence,
    command: JSON.parse(row.command),
    envelope: JSON.parse(row.envelope),
    deliveries: row.deliveries,
    createdAt: row.created_at,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    fetchedAt: row.fetched_at,
    acknowledgedAt: row.acknowledged_at,
    cancelRequestedAt: row.cancel_requested_at,
    result: row.result === null ? null : JSON.parse(row.result),
    resultAt: row.result_at,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
    settledAt: row.settled_at,
  };
}

export function recordRetroDispatch(
  db: Database,
  input: {
    commandId: string;
    retroId: string;
    attempt: number;
    workspaceId: string;
    runnerId: string;
    runnerFence: number;
    command: unknown;
    envelope: unknown;
    issuedAt: number;
    expiresAt: number;
    now: number;
  },
): RetroDispatch {
  db.run(
    `INSERT INTO retro_dispatch (command_id, retro_id, attempt, workspace_id, runner_id,
       runner_fence, command, envelope, created_at, issued_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.commandId,
      input.retroId,
      input.attempt,
      input.workspaceId,
      input.runnerId,
      input.runnerFence,
      JSON.stringify(input.command),
      JSON.stringify(input.envelope),
      input.now,
      input.issuedAt,
      input.expiresAt,
    ],
  );
  return getRetroDispatch(db, input.commandId)!;
}

export function getRetroDispatch(db: Database, commandId: string): RetroDispatch | null {
  const row = db
    .query<DispatchRow, [string]>("SELECT * FROM retro_dispatch WHERE command_id = ?")
    .get(commandId);
  return row === null ? null : fromRow(row);
}

export function listRetroDispatches(db: Database, retroId: string): RetroDispatch[] {
  return db
    .query<DispatchRow, [string]>(
      "SELECT * FROM retro_dispatch WHERE retro_id = ? ORDER BY attempt",
    )
    .all(retroId)
    .map(fromRow);
}

export function openRetroDispatch(db: Database, retroId: string): RetroDispatch | null {
  const row = db
    .query<DispatchRow, [string]>(
      `SELECT * FROM retro_dispatch WHERE retro_id = ? AND (released_at IS NULL OR settled_at IS NULL)
       ORDER BY attempt DESC LIMIT 1`,
    )
    .get(retroId);
  return row === null ? null : fromRow(row);
}

export function unfinishedRetroDispatches(db: Database): RetroDispatch[] {
  return db
    .query<DispatchRow, []>(
      "SELECT * FROM retro_dispatch WHERE released_at IS NULL OR settled_at IS NULL ORDER BY created_at",
    )
    .all()
    .map(fromRow);
}

export function deliverableRetroDispatches(db: Database, runnerId: string): RetroDispatch[] {
  return db
    .query<DispatchRow, [string]>(
      `SELECT * FROM retro_dispatch WHERE runner_id = ? AND released_at IS NULL
       AND acknowledged_at IS NULL AND cancel_requested_at IS NULL ORDER BY created_at LIMIT 16`,
    )
    .all(runnerId)
    .map(fromRow);
}

export function retroSlotsHeld(db: Database, runnerId: string): number {
  return (
    db
      .query<{ held: number }, [string]>(
        "SELECT count(*) AS held FROM retro_dispatch WHERE runner_id = ? AND released_at IS NULL",
      )
      .get(runnerId)?.held ?? 0
  );
}

export function retroDispatchesNotStarted(db: Database, retroId: string): number {
  return (
    db
      .query<{ count: number }, [string]>(
        "SELECT count(*) AS count FROM retro_dispatch WHERE retro_id = ? AND release_reason = 'not_started'",
      )
      .get(retroId)?.count ?? 0
  );
}

export function markRetroDispatchFetched(db: Database, commandId: string, now: number): void {
  db.run(
    "UPDATE retro_dispatch SET fetched_at = COALESCE(fetched_at, ?) WHERE command_id = ? AND released_at IS NULL",
    [now, commandId],
  );
}

export function resignRetroDispatch(
  db: Database,
  input: { commandId: string; envelope: unknown; issuedAt: number; expiresAt: number },
): boolean {
  return (
    db.run(
      `UPDATE retro_dispatch SET envelope = ?, issued_at = ?, expires_at = ?, deliveries = deliveries + 1
       WHERE command_id = ? AND released_at IS NULL AND fetched_at IS NULL AND acknowledged_at IS NULL`,
      [JSON.stringify(input.envelope), input.issuedAt, input.expiresAt, input.commandId],
    ).changes === 1
  );
}

export function acknowledgeRetroDispatch(db: Database, commandId: string, now: number): boolean {
  return (
    db.run(
      `UPDATE retro_dispatch SET acknowledged_at = COALESCE(acknowledged_at, ?),
         fetched_at = COALESCE(fetched_at, ?)
       WHERE command_id = ? AND released_at IS NULL AND cancel_requested_at IS NULL`,
      [now, now, commandId],
    ).changes === 1
  );
}

export function requestRetroDispatchCancel(db: Database, commandId: string, now: number): void {
  db.run(
    "UPDATE retro_dispatch SET cancel_requested_at = COALESCE(cancel_requested_at, ?) WHERE command_id = ? AND released_at IS NULL",
    [now, commandId],
  );
}

export function recordRetroDispatchResult(
  db: Database,
  input: { commandId: string; result: unknown; now: number },
): "recorded" | "duplicate" | "conflict" | "released" {
  return immediate(db, () => {
    const dispatch = getRetroDispatch(db, input.commandId);
    if (dispatch === null) return "released";
    const text = JSON.stringify(input.result);
    if (dispatch.result !== null)
      return JSON.stringify(dispatch.result) === text ? "duplicate" : "conflict";
    if (dispatch.releasedAt !== null) return "released";
    db.run(
      `UPDATE retro_dispatch SET result = ?, result_at = ?, released_at = ?, release_reason = 'result',
         acknowledged_at = COALESCE(acknowledged_at, ?) WHERE command_id = ?`,
      [text, input.now, input.now, input.now, input.commandId],
    );
    return "recorded";
  });
}

export function releaseRetroDispatch(
  db: Database,
  input: { commandId: string; reason: Exclude<RetroDispatchRelease, "result">; now: number },
): boolean {
  return (
    db.run(
      "UPDATE retro_dispatch SET released_at = ?, release_reason = ? WHERE command_id = ? AND released_at IS NULL",
      [input.now, input.reason, input.commandId],
    ).changes === 1
  );
}

export function settleRetroDispatch(db: Database, commandId: string, now: number): void {
  db.run(
    "UPDATE retro_dispatch SET settled_at = COALESCE(settled_at, ?) WHERE command_id = ? AND released_at IS NOT NULL",
    [now, commandId],
  );
}

export function recordRetroGeneration(
  db: Database,
  input: {
    retroId: string;
    diagnostic: RetroGenerationDiagnostic;
    detail: string;
    now: number;
    until?: number | null;
    activeMs?: number;
  },
): RetroGenerationRow {
  return immediate(db, () => {
    const previous = retroGeneration(db, input.retroId);
    const waited =
      previous !== null && RETRO_WAIT_DIAGNOSTICS.includes(previous.diagnostic)
        ? Math.max(0, input.now - previous.updatedAt)
        : 0;
    const since =
      previous !== null && previous.diagnostic === input.diagnostic ? previous.since : input.now;
    db.run(
      `INSERT INTO retro_generation (retro_id, diagnostic, detail, since, until, wait_ms, active_ms,
         updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (retro_id) DO UPDATE SET diagnostic = excluded.diagnostic,
         detail = excluded.detail, since = excluded.since, until = excluded.until,
         wait_ms = excluded.wait_ms, active_ms = excluded.active_ms, updated_at = excluded.updated_at`,
      [
        input.retroId,
        input.diagnostic,
        input.detail.slice(0, 2000),
        since,
        input.until ?? null,
        (previous?.waitMs ?? 0) + waited,
        (previous?.activeMs ?? 0) + Math.max(0, input.activeMs ?? 0),
        input.now,
      ],
    );
    return retroGeneration(db, input.retroId)!;
  });
}

export function retroGeneration(db: Database, retroId: string): RetroGenerationRow | null {
  return db
    .query<RetroGenerationRow, [string]>(
      `SELECT retro_id AS retroId, diagnostic, detail, since, until, wait_ms AS waitMs,
         active_ms AS activeMs, updated_at AS updatedAt FROM retro_generation WHERE retro_id = ?`,
    )
    .get(retroId);
}
