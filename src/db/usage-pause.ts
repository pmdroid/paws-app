import type { Database } from "bun:sqlite";

/** A run waiting for its agent's usage limit to reset. */
export type UsagePause = {
  runId: string;
  itemId: string;
  agent: string;
  runnerId: string | null;
  resetsAt: number | null;
  resumeAt: number;
  pausedAt: number;
};

const COLUMNS =
  "run_id AS runId,item_id AS itemId,agent,runner_id AS runnerId,resets_at AS resetsAt,resume_at AS resumeAt,paused_at AS pausedAt";

export function startUsagePause(db: Database, pause: UsagePause): void {
  db.run(
    `INSERT INTO usage_pause(run_id,item_id,agent,runner_id,resets_at,resume_at,paused_at) VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(run_id) DO UPDATE SET agent=excluded.agent,runner_id=excluded.runner_id,
     resets_at=excluded.resets_at,resume_at=excluded.resume_at,paused_at=excluded.paused_at`,
    [
      pause.runId,
      pause.itemId,
      pause.agent,
      pause.runnerId,
      pause.resetsAt,
      pause.resumeAt,
      pause.pausedAt,
    ],
  );
}

export function usagePause(db: Database, runId: string): UsagePause | null {
  return db
    .query<UsagePause, [string]>(`SELECT ${COLUMNS} FROM usage_pause WHERE run_id=?`)
    .get(runId);
}

export function endUsagePause(db: Database, runId: string): void {
  db.run("DELETE FROM usage_pause WHERE run_id=?", [runId]);
}

/** Resume now: end the wait and lift the agent's cooldown so placement can try it again. */
export function resumeUsagePauseNow(db: Database, runId: string, now: number): boolean {
  return db
    .transaction(() => {
      const pause = usagePause(db, runId);
      if (!pause) return false;
      db.run("UPDATE usage_pause SET resume_at=? WHERE run_id=?", [now, runId]);
      const runner = pause.runnerId === null ? "" : " AND runner_id=?";
      const args =
        pause.runnerId === null ? [now, pause.agent] : [now, pause.agent, pause.runnerId];
      db.run(
        `UPDATE runner_member_account SET cooldown_until=0,updated_at=? WHERE agent=? AND cooldown_until>0${runner}`,
        args,
      );
      db.run(
        `UPDATE runner_agent_policy SET cooldown_until=0 WHERE agent=? AND cooldown_until>0${runner}`,
        args.slice(1),
      );
      return true;
    })
    .immediate();
}

/** A pause lives in the process that waits for it; a restart starts from no waits. */
export function clearUsagePauses(db: Database): void {
  db.run("DELETE FROM usage_pause");
}
