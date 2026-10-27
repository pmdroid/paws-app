import type { Database } from "bun:sqlite";
import { readCheckpoint } from "./checkpoint";
import { randomUUID } from "node:crypto";
import type { Checkpoint, RunKind, RunStatus, GitCommitPolicy } from "../core";

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

/** How many review rounds the item needed by the time this run verified it. */
export function recordReviewRounds(db: Database, id: string, rounds: number): void {
  db.run(
    `INSERT INTO run_review_rounds (run_id, rounds) VALUES (?, ?)
     ON CONFLICT (run_id) DO UPDATE SET rounds = excluded.rounds`,
    [id, rounds],
  );
}

/** The review rounds recorded on the run, or null when it never verified a review. */
export function reviewRoundsOf(db: Database, id: string): number | null {
  return (
    db
      .query<{ rounds: number | null }, [string]>(
        "SELECT rounds FROM run_review_rounds WHERE run_id = ?",
      )
      .get(id)?.rounds ?? null
  );
}

export function releaseRunCapacity(db: Database, runId: string, now: number): void {
  const run = getRun(db, runId);
  if (run && (run.status === "active" || run.status === "provisioning"))
    markRun(db, runId, "ended", now);
  db.run("UPDATE runner_work SET ended_at = ? WHERE run_id = ? AND ended_at IS NULL", [now, runId]);
  db.run("DELETE FROM runner_work_grant WHERE run_id = ?", [runId]);
}

export function saveRunResult(db: Database, id: string, resultBody: string, now: number): void {
  const run = getRun(db, id);
  if (run === null) throw new Error(`run ${id} not found`);
  const checkpoint = { ...(run.checkpoint ?? { phase: "running" }), resultBody };
  db.run("UPDATE run SET checkpoint = ?, updated_at = ? WHERE id = ?", [
    JSON.stringify(checkpoint),
    now,
    id,
  ]);
}

function mapRun(row: RunSql): StoredRun {
  return {
    id: row.id,
    itemId: row.item_id,
    kind: row.kind,
    agent: row.agent,
    status: row.status,
    checkpoint: row.checkpoint === null ? null : readCheckpoint(row.checkpoint),
    freshSession: row.fresh_session === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function saveRunCommitPolicy(db: Database, id: string, policy: GitCommitPolicy): void {
  const run = getRun(db, id);
  if (!run) throw new Error("Attribution run is missing");
  if (
    run.checkpoint?.commitPolicy &&
    JSON.stringify(run.checkpoint.commitPolicy) !== JSON.stringify(policy)
  )
    throw new Error("Run attribution snapshot cannot change");
  db.run("UPDATE run SET checkpoint=? WHERE id=?", [
    JSON.stringify({ ...(run.checkpoint ?? { phase: "running" }), commitPolicy: policy }),
    id,
  ]);
}

/**
 * The run's checkout exclusions. The first call stores `resolve()` on the run; every later call
 * returns that, so a settings change never alters a checkout a run already started with.
 */
export function pinRunCheckout(
  db: Database,
  id: string,
  resolve: () => NonNullable<Checkpoint["checkout"]>,
): NonNullable<Checkpoint["checkout"]> {
  const run = getRun(db, id);
  if (!run) return resolve();
  if (run.checkpoint?.checkout) return run.checkpoint.checkout;
  const checkout = resolve();
  db.run("UPDATE run SET checkpoint=? WHERE id=?", [
    JSON.stringify({ ...(run.checkpoint ?? { phase: "running" }), checkout }),
    id,
  ]);
  return checkout;
}

export function getItemRunCommitPolicy(db: Database, itemId: string): GitCommitPolicy | undefined {
  return listRuns(db, itemId)
    .toReversed()
    .find((run) => run.checkpoint?.commitPolicy)?.checkpoint?.commitPolicy;
}

/** Existing runs eligible for a Settings profile update. A live work lease owns its snapshot. */
export function listWaitingProfileRuns(db: Database, now: number): StoredRun[] {
  return db
    .query<RunSql, [number]>(
      `SELECT r.* FROM run r JOIN work_item i ON i.id=r.item_id
     WHERE i.state NOT IN ('queued','completed','merged','cancelled') AND i.cancel_requested=0
       AND NOT EXISTS (SELECT 1 FROM runner_work w WHERE w.run_id=r.id
         AND w.ended_at IS NULL AND w.lease_until>?)
     ORDER BY r.created_at,r.id`,
    )
    .all(now)
    .map(mapRun);
}
