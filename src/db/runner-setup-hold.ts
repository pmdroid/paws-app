import type { Database } from "bun:sqlite";

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
  since: number;
  notifiedAt: number | null;
};

export function getRunnerSetupHold(db: Database, itemId: string): RunnerSetupHold | null {
  return db
    .query<RunnerSetupHold, [string]>(
      `SELECT item_id AS itemId,owner_user_id AS ownerUserId,reason,runner_id AS runnerId,agent,
       since,notified_at AS notifiedAt FROM runner_setup_hold WHERE item_id=?`,
    )
    .get(itemId);
}

export function listRunnerSetupHolds(db: Database): RunnerSetupHold[] {
  return db
    .query<RunnerSetupHold, []>(
      `SELECT item_id AS itemId,owner_user_id AS ownerUserId,reason,runner_id AS runnerId,agent,
       since,notified_at AS notifiedAt FROM runner_setup_hold ORDER BY since,item_id`,
    )
    .all();
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
    now: number;
  },
): RunnerSetupHold {
  db.run(
    `INSERT INTO runner_setup_hold(item_id,owner_user_id,reason,runner_id,agent,since)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(item_id) DO UPDATE SET owner_user_id=excluded.owner_user_id,
     reason=excluded.reason,runner_id=excluded.runner_id,agent=excluded.agent`,
    [
      input.itemId,
      input.ownerUserId,
      input.reason,
      input.runnerId ?? null,
      input.agent ?? null,
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

/** End a hold, for the resume that starts the item again. */
export function releaseRunnerSetupHold(db: Database, itemId: string): boolean {
  return db.run("DELETE FROM runner_setup_hold WHERE item_id=?", [itemId]).changes > 0;
}
