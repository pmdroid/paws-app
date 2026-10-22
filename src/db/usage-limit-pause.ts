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
  /** The paused runner's display name, when the limit was observed on a runner. */
  runnerName?: string | null;
};

/**
 * The agent call a usage limit interrupted, kept apart from the wait so a restart, or other calls
 * such as preflight probes, cannot lose it. Only the same call (`runKey`) continues it.
 */
export type UsageLimitContinuation = {
  itemId: string;
  runKey: string;
  prompt: string;
  session: { runnerId: string; sessionId: string } | null;
};

const COLUMNS =
  "p.item_id AS itemId,p.run_id AS runId,p.agent,p.runner_id AS runnerId,p.resets_at AS resetsAt,p.resume_at AS resumeAt,p.paused_at AS pausedAt,r.name AS runnerName";

export function getUsageLimitPause(db: Database, itemId: string): UsageLimitPause | null {
  return (
    db
      .query<UsageLimitPause, [string]>(
        `SELECT ${COLUMNS} FROM usage_limit_pause p LEFT JOIN runner r ON r.id=p.runner_id WHERE p.item_id=?`,
      )
      .get(itemId) ?? null
  );
}

/**
 * Records the pause and returns true when the item was not already waiting. A pause that survives
 * a restart keeps waiting under the same row, so Linear does not hear about it twice.
 */
export function saveUsageLimitPause(db: Database, pause: UsageLimitPause): boolean {
  const existing = getUsageLimitPause(db, pause.itemId);
  db.run(
    `INSERT INTO usage_limit_pause(item_id,run_id,agent,runner_id,resets_at,resume_at,paused_at)
     VALUES(?,?,?,?,?,?,?)
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
  return existing === null;
}

/**
 * Makes the pause due now and lifts the agent's cooldown so placement tries the agent again
 * instead of pausing on the same cooldown. Only runners the task can be placed on change: the
 * paused runner when one is known, otherwise the runners of the task's Linear workspace.
 */
export function resumeUsageLimitPauseNow(db: Database, itemId: string, now: number): boolean {
  const pause = getUsageLimitPause(db, itemId);
  if (!pause) return false;
  db.run("UPDATE usage_limit_pause SET resume_at=MIN(resume_at,?) WHERE item_id=?", [now, itemId]);
  for (const table of ["runner_member_account", "runner_agent_policy"])
    db.run(
      `UPDATE ${table} SET cooldown_until=0 WHERE agent=?1 AND cooldown_until>?2
       AND (?3 IS NULL OR runner_id=?3) AND runner_id IN (
         SELECT r.id FROM runner r JOIN workspace w ON w.id=r.workspace_id
         JOIN linear_session s ON s.organization_id=w.linear_organization_id
         JOIN work_item i ON i.session_key=s.session_id
         WHERE i.id=?4 AND r.status='active' AND r.revoked_at IS NULL)`,
      [pause.agent, now, pause.runnerId, itemId],
    );
  return true;
}

export function clearUsageLimitPause(db: Database, itemId: string): void {
  db.run("DELETE FROM usage_limit_pause WHERE item_id=?", [itemId]);
}

export function getUsageLimitContinuation(
  db: Database,
  itemId: string,
): UsageLimitContinuation | null {
  const row = db
    .query<
      { runKey: string; prompt: string; sessionRunnerId: string | null; sessionId: string | null },
      [string]
    >(
      "SELECT run_key AS runKey,prompt,session_runner_id AS sessionRunnerId,session_id AS sessionId FROM usage_limit_continuation WHERE item_id=?",
    )
    .get(itemId);
  if (!row) return null;
  return {
    itemId,
    runKey: row.runKey,
    prompt: row.prompt,
    session:
      row.sessionRunnerId && row.sessionId
        ? { runnerId: row.sessionRunnerId, sessionId: row.sessionId }
        : null,
  };
}

export function saveUsageLimitContinuation(db: Database, continuation: UsageLimitContinuation) {
  db.run(
    "INSERT OR REPLACE INTO usage_limit_continuation(item_id,run_key,prompt,session_runner_id,session_id) VALUES(?,?,?,?,?)",
    [
      continuation.itemId,
      continuation.runKey,
      continuation.prompt,
      continuation.session?.runnerId ?? null,
      continuation.session?.sessionId ?? null,
    ],
  );
}

export function clearUsageLimitContinuation(db: Database, itemId: string, runKey?: string): void {
  db.run("DELETE FROM usage_limit_continuation WHERE item_id=?1 AND (?2 IS NULL OR run_key=?2)", [
    itemId,
    runKey ?? null,
  ]);
}
