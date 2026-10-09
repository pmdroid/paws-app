import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Checkpoint, RunKind, RunStatus } from "../core";

export type StoredRun = {
  id: string;
  itemId: string;
  kind: RunKind;
  agent: string;
  status: RunStatus;
  checkpoint: Checkpoint | null;
  freshSession: boolean;
  createdAt: number;
  updatedAt: number;
};

type RunSql = {
  id: string;
  item_id: string;
  kind: RunKind;
  agent: string;
  status: RunStatus;
  checkpoint: string | null;
  fresh_session: number;
  created_at: number;
  updated_at: number;
};

export function insertRun(
  db: Database,
  input: {
    itemId: string;
    now: number;
    kind?: RunKind;
    agent?: string;
    status?: RunStatus;
    checkpoint?: Checkpoint | null;
    freshSession?: boolean;
  },
): StoredRun {
  const id = randomUUID();
  const checkpoint = input.checkpoint ?? null;
  db.run(
    `INSERT INTO run (id, item_id, kind, agent, status, checkpoint, fresh_session, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.itemId,
      input.kind ?? "implement",
      input.agent ?? "cursor",
      input.status ?? "active",
      checkpoint === null ? null : JSON.stringify(checkpoint),
      input.freshSession === true ? 1 : 0,
      input.now,
      input.now,
    ],
  );
  const run = getRun(db, id);
  if (run === null) throw new Error("insertRun did not store a row");
  return run;
}

export function getRun(db: Database, id: string): StoredRun | null {
  const row = db.query<RunSql, [string]>("SELECT * FROM run WHERE id = ?").get(id);
  return row === null ? null : mapRun(row);
}

/** Every run, oldest first. Pass `itemId` to keep one work item. */
export function listRuns(db: Database, itemId?: string): StoredRun[] {
  if (itemId !== undefined) {
    return db
      .query<RunSql, [string]>("SELECT * FROM run WHERE item_id = ? ORDER BY created_at, id")
      .all(itemId)
      .map(mapRun);
  }
  return db.query<RunSql, []>("SELECT * FROM run ORDER BY created_at, id").all().map(mapRun);
}

export function markRun(db: Database, id: string, status: RunStatus, now: number): void {
  db.run("UPDATE run SET status = ?, updated_at = ? WHERE id = ?", [status, now, id]);
}

function mapRun(row: RunSql): StoredRun {
  return {
    id: row.id,
    itemId: row.item_id,
    kind: row.kind,
    agent: row.agent,
    status: row.status,
    checkpoint: row.checkpoint === null ? null : (JSON.parse(row.checkpoint) as Checkpoint),
    freshSession: row.fresh_session === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
