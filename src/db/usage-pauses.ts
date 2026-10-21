import type { Database } from "bun:sqlite";
import { immediate } from "./tx";

/**
 * A task waiting for its agent's usage limit to reset. The task keeps its
 * state, branch, worktree and run while the row exists; the runner backend
 * owns the wait and removes the row when it ends.
 */
export type UsagePause = {
  itemId: string;
  role: "implementer" | "reviewer";
  agent: string;
  runnerId: string | null;
  accountUserId: string | null;
  resetsAt: number | null;
  resumeAt: number;
  pausedAt: number;
  resumeRequested: boolean;
};

type PauseRow = {
  item_id: string;
  role: "implementer" | "reviewer";
  agent: string;
  runner_id: string | null;
  account_user_id: string | null;
  resets_at: number | null;
  resume_at: number;
  paused_at: number;
  resume_requested: number;
};

export function saveUsagePause(db: Database, pause: Omit<UsagePause, "resumeRequested">): void {
  db.run(
    `INSERT OR REPLACE INTO usage_pause
     (item_id, role, agent, runner_id, account_user_id, resets_at, resume_at, paused_at, resume_requested)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      pause.itemId,
      pause.role,
      pause.agent,
      pause.runnerId,
      pause.accountUserId,
      pause.resetsAt,
      pause.resumeAt,
      pause.pausedAt,
    ],
  );
}

export function getUsagePause(db: Database, itemId: string): UsagePause | null {
  const row = db
    .query<PauseRow, [string]>("SELECT * FROM usage_pause WHERE item_id = ?")
    .get(itemId);
  return row
    ? {
        itemId: row.item_id,
        role: row.role,
        agent: row.agent,
        runnerId: row.runner_id,
        accountUserId: row.account_user_id,
        resetsAt: row.resets_at,
        resumeAt: row.resume_at,
        pausedAt: row.paused_at,
        resumeRequested: row.resume_requested === 1,
      }
    : null;
}

/** Removes the pause that began at `pausedAt`, leaving a newer one in place. */
export function endUsagePause(db: Database, itemId: string, pausedAt?: number): void {
  if (pausedAt === undefined) db.run("DELETE FROM usage_pause WHERE item_id = ?", [itemId]);
  else db.run("DELETE FROM usage_pause WHERE item_id = ? AND paused_at = ?", [itemId, pausedAt]);
}

/**
 * Resume now: lifts the cooldown on the account that hit the limit so placement
 * admits it again, and wakes the waiting task. Returns false when nothing waits.
 */
export function requestUsageResume(db: Database, itemId: string): boolean {
  return immediate(db, () => {
    const pause = getUsagePause(db, itemId);
    if (!pause) return false;
    db.run("UPDATE usage_pause SET resume_requested = 1 WHERE item_id = ?", [itemId]);
    if (pause.runnerId && pause.accountUserId)
      db.run(
        "UPDATE runner_member_account SET cooldown_until = 0 WHERE runner_id = ? AND user_id = ? AND agent = ?",
        [pause.runnerId, pause.accountUserId, pause.agent],
      );
    else if (pause.runnerId)
      db.run(
        "UPDATE runner_agent_policy SET cooldown_until = 0 WHERE runner_id = ? AND agent = ?",
        [pause.runnerId, pause.agent],
      );
    return true;
  });
}
