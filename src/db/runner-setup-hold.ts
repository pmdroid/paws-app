import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../core";
import { enqueueJob } from "./jobs";

/**
 * A queued item held because its delegator has no runner Paws may use. The scheduler skips it,
 * nothing retries it, and no start timeout applies. Migration 139 deletes the row when the item
 * leaves the queue or a Stop is requested.
 */
export type RunnerSetupHold = {
  itemId: string;
  ownerUserId: string | null;
  reason: "no-runner" | "agent-not-signed-in";
  runnerId: string | null;
  agent: string | null;
  /** The run the hold stopped, which the resume picks up again. */
  runId: string | null;
  since: number;
  notifiedAt: number | null;
};

export function getRunnerSetupHold(db: Database, itemId: string): RunnerSetupHold | null {
  return db
    .query<RunnerSetupHold, [string]>(
      `SELECT item_id AS itemId,owner_user_id AS ownerUserId,reason,runner_id AS runnerId,agent,
       run_id AS runId,since,notified_at AS notifiedAt FROM runner_setup_hold WHERE item_id=?`,
    )
    .get(itemId);
}

export function listRunnerSetupHolds(db: Database, ownerUserId?: string): RunnerSetupHold[] {
  const select = `SELECT item_id AS itemId,owner_user_id AS ownerUserId,reason,runner_id AS runnerId,
       agent,run_id AS runId,since,notified_at AS notifiedAt FROM runner_setup_hold`;
  return ownerUserId === undefined
    ? db.query<RunnerSetupHold, []>(`${select} ORDER BY since,item_id`).all()
    : db
        .query<RunnerSetupHold, [string]>(`${select} WHERE owner_user_id=? ORDER BY since,item_id`)
        .all(ownerUserId);
}

/**
 * Hold a queued item for runner setup. A hold that already exists keeps its `since` and
 * `notified_at` and takes the latest reason. Call inside the transaction that queues the item.
 */
export function holdForRunnerSetup(
  db: Database,
  input: {
    itemId: string;
    ownerUserId: string | null;
    reason: RunnerSetupHold["reason"];
    runnerId?: string | null;
    agent?: string | null;
    runId?: string | null;
    now: number;
  },
): RunnerSetupHold {
  db.run(
    `INSERT INTO runner_setup_hold(item_id,owner_user_id,reason,runner_id,agent,run_id,since)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(item_id) DO UPDATE SET owner_user_id=excluded.owner_user_id,
     reason=excluded.reason,runner_id=excluded.runner_id,agent=excluded.agent,
     run_id=COALESCE(excluded.run_id,runner_setup_hold.run_id)`,
    [
      input.itemId,
      input.ownerUserId,
      input.reason,
      input.runnerId ?? null,
      input.agent ?? null,
      input.runId ?? null,
      input.now,
    ],
  );
  return getRunnerSetupHold(db, input.itemId)!;
}

export function markRunnerSetupNotified(db: Database, itemId: string, now: number): void {
  db.run("UPDATE runner_setup_hold SET notified_at=? WHERE item_id=? AND notified_at IS NULL", [
    now,
    itemId,
  ]);
}

/**
 * End a hold, for the resume that starts the item again. A hold that stopped a run leaves that
 * run for `takeRunnerSetupResume`. False when the hold was already gone, so two checks at once
 * resume the item once. Call inside the transaction that posts the resume.
 */
export function releaseRunnerSetupHold(db: Database, itemId: string, now?: number): boolean {
  const hold = getRunnerSetupHold(db, itemId);
  if (!hold || db.run("DELETE FROM runner_setup_hold WHERE item_id=?", [itemId]).changes === 0)
    return false;
  if (hold.runId !== null && now !== undefined)
    db.run(
      `INSERT INTO runner_setup_resume(item_id,run_id,released_at) VALUES(?,?,?)
       ON CONFLICT(item_id) DO UPDATE SET run_id=excluded.run_id,released_at=excluded.released_at`,
      [itemId, hold.runId, now],
    );
  return true;
}

/**
 * Whether `runId` is the run a released runner-setup hold stopped, so the start continues it
 * instead of opening a new one. Consumes the record either way.
 */
export function takeRunnerSetupResume(db: Database, itemId: string, runId: string): boolean {
  const row = db
    .query<{ runId: string }, [string]>(
      "DELETE FROM runner_setup_resume WHERE item_id=? RETURNING run_id AS runId",
    )
    .get(itemId);
  return row?.runId === runId;
}

/**
 * Queue one `runner_setup.check` job for `ownerUserId` unless one is already pending, the same
 * rule the triggers of migration 144 follow.
 */
export function enqueueRunnerSetupCheck(db: Database, ownerUserId: string, now: number): void {
  const pending = db
    .query(
      `SELECT 1 FROM job WHERE queue=? AND status='pending'
       AND json_extract(payload,'$.ownerUserId')=? LIMIT 1`,
    )
    .get(JOB_KIND.runnerSetupCheck, ownerUserId);
  if (pending) return;
  enqueueJob(db, {
    queue: JOB_KIND.runnerSetupCheck,
    payload: { ownerUserId },
    maxAttempts: 3,
    now,
  });
}
