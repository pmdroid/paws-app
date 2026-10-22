import type { Database } from "bun:sqlite";
import type { WorkItemState } from "../core";
import { listWorkItemsByStates, type WorkItemRecord } from "./items";

export type PawsUpdateStatus = "waiting" | "applying" | "failed";

/** The one scheduled update of this Paws checkout. */
export type PawsUpdate = {
  target: string;
  current: string;
  status: PawsUpdateStatus;
  source: "automatic" | "manual";
  nowRequested: boolean;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

type Row = {
  target: string;
  current: string;
  status: PawsUpdateStatus;
  source: "automatic" | "manual";
  now_requested: number;
  error: string | null;
  created_at: number;
  updated_at: number;
};

/** Work that holds an update. Questions, CI and the merge queue do not. */
export const UPDATE_HOLDING_STATES = [
  "running",
  "verifying",
  "recovering",
] as const satisfies readonly WorkItemState[];

export function getPawsUpdate(db: Database): PawsUpdate | null {
  const row = db.query<Row, []>("SELECT * FROM paws_update WHERE id = 1").get();
  if (row === null) return null;
  return {
    target: row.target,
    current: row.current,
    status: row.status,
    source: row.source,
    nowRequested: row.now_requested === 1,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Wait for `target`. An automatic check does not retry a target that already
 * failed, so a broken commit is not installed every ten minutes.
 */
export function schedulePawsUpdate(
  db: Database,
  input: { target: string; current: string; source: "automatic" | "manual"; now: number },
): PawsUpdate {
  const existing = getPawsUpdate(db);
  if (existing?.status === "applying") return existing;
  if (
    existing !== null &&
    existing.target === input.target &&
    (existing.status === "waiting" || input.source === "automatic")
  )
    return existing;
  db.run(
    `INSERT INTO paws_update (id, target, current, status, source, now_requested, error, created_at, updated_at)
     VALUES (1, ?, ?, 'waiting', ?, 0, NULL, ?, ?)
     ON CONFLICT(id) DO UPDATE SET target = excluded.target, current = excluded.current,
       status = 'waiting', source = excluded.source, now_requested = 0, error = NULL,
       created_at = excluded.created_at, updated_at = excluded.updated_at`,
    [input.target, input.current, input.source, input.now, input.now],
  );
  return getPawsUpdate(db)!;
}

/** **Update now**: apply on the next tick without waiting for running work. */
export function requestPawsUpdateNow(db: Database, now: number): boolean {
  return (
    db.run(
      "UPDATE paws_update SET now_requested = 1, updated_at = ? WHERE id = 1 AND status = 'waiting'",
      [now],
    ).changes > 0
  );
}

/** **Cancel** drops a waiting update, or dismisses a failed one. */
export function cancelPawsUpdate(db: Database): boolean {
  return db.run("DELETE FROM paws_update WHERE id = 1 AND status != 'applying'").changes > 0;
}

export function markPawsUpdate(
  db: Database,
  status: PawsUpdateStatus,
  now: number,
  error: string | null = null,
): void {
  db.run("UPDATE paws_update SET status = ?, error = ?, updated_at = ? WHERE id = 1", [
    status,
    error,
    now,
  ]);
}

export function listUpdateHolders(db: Database): WorkItemRecord[] {
  return listWorkItemsByStates(db, UPDATE_HOLDING_STATES).filter((item) => !item.cancelRequested);
}

/** The new code is running: the update is done. */
export function clearPawsUpdate(db: Database): void {
  db.run("DELETE FROM paws_update WHERE id = 1");
}
