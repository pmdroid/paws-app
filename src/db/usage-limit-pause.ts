import type { Database } from "bun:sqlite";

/** An item waiting for its agent's usage limit to reset. One row per item while it waits. */
export type UsageLimitPause = {
  itemId: string;
  runId: string;
  agent: string;
  runnerId: string | null;
  resetsAt: number | null;
  resumeAt: number;
  pausedAt: number;
};

const COLUMNS =
  "item_id AS itemId,run_id AS runId,agent,runner_id AS runnerId,resets_at AS resetsAt,resume_at AS resumeAt,paused_at AS pausedAt";

export function getUsageLimitPause(db: Database, itemId: string): UsageLimitPause | null {
  return (
    db
      .query<UsageLimitPause, [string]>(`SELECT ${COLUMNS} FROM usage_limit_pause WHERE item_id=?`)
      .get(itemId) ?? null
  );
}

/** Records the pause and returns true when the item was not already waiting. */
export function saveUsageLimitPause(db: Database, pause: UsageLimitPause): boolean {
  const existing = getUsageLimitPause(db, pause.itemId);
  db.run(
    `INSERT INTO usage_limit_pause(item_id,run_id,agent,runner_id,resets_at,resume_at,paused_at) VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(item_id) DO UPDATE SET run_id=excluded.run_id,agent=excluded.agent,runner_id=excluded.runner_id,
     resets_at=excluded.resets_at,resume_at=excluded.resume_at`,
    [
      pause.itemId,
      pause.runId,
      pause.agent,
      pause.runnerId,
      pause.resetsAt,
      pause.resumeAt,
      pause.pausedAt,
    ],
  );
  return existing === null || existing.runId !== pause.runId;
}

/**
 * Makes the pause due now and lifts the agent's cooldown, on the paused runner when one is known,
 * so placement tries the agent again instead of pausing on the same cooldown.
 */
export function resumeUsageLimitPauseNow(db: Database, itemId: string, now: number): boolean {
  const pause = getUsageLimitPause(db, itemId);
  if (!pause) return false;
  db.run("UPDATE usage_limit_pause SET resume_at=MIN(resume_at,?) WHERE item_id=?", [now, itemId]);
  for (const table of ["runner_member_account", "runner_agent_policy"])
    db.run(
      `UPDATE ${table} SET cooldown_until=0 WHERE agent=?1 AND cooldown_until>?2 AND (?3 IS NULL OR runner_id=?3)`,
      [pause.agent, now, pause.runnerId],
    );
  return true;
}

export function clearUsageLimitPause(db: Database, itemId: string): void {
  db.run("DELETE FROM usage_limit_pause WHERE item_id=?", [itemId]);
}
