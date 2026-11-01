import type { Database } from "bun:sqlite";
import type { WorkItemRecord } from "./items";
import { reenqueueJob } from "./jobs";

export const RESTART_QUESTION =
  "Paws restarted twice while this task was running. Start it again from its branch in a fresh session? Stop the session to leave it.";

export type RestartHold = { itemId: string; sessionId: string; requestedAt: number };

const HELD_STATES: readonly string[] = ["recovering", "awaiting_input"];

export function restartHold(db: Database, item: WorkItemRecord): RestartHold | null {
  if (item.sessionKey === null || item.cancelRequested || !HELD_STATES.includes(item.state))
    return null;
  return db
    .query<RestartHold, [string, string]>(
      `SELECT item_id AS itemId, session_id AS sessionId, requested_at AS requestedAt
       FROM restart_hold WHERE item_id = ? AND session_id = ?`,
    )
    .get(item.id, item.sessionKey);
}

export function holdRestart(db: Database, item: WorkItemRecord, now: number): void {
  db.run(
    `INSERT INTO restart_hold (item_id, session_id, requested_at) VALUES (?1, ?2, ?3)
     ON CONFLICT (item_id) DO UPDATE SET session_id = ?2, requested_at = ?3
     WHERE restart_hold.session_id <> ?2`,
    [item.id, item.sessionKey, now],
  );
}

export function restartQuestionStands(db: Database, item: WorkItemRecord): boolean {
  return (
    db
      .query(
        `SELECT 1 FROM question WHERE item_id = ? AND session_id = ? AND reason = 'restart'
         AND cancelled_at IS NULL
         AND (status IN ('open', 'queued') OR (status = 'answered' AND handoff_version IS NULL))`,
      )
      .get(item.id, item.sessionKey) !== null
  );
}

function restartQuestionQueued(db: Database, itemId: string): boolean {
  return (
    db
      .query(
        `SELECT 1 FROM job WHERE queue = 'item.ask' AND status IN ('pending', 'running')
         AND json_extract(payload, '$.itemId') = ? AND json_extract(payload, '$.reason') = 'restart'`,
      )
      .get(itemId) !== null
  );
}

export function ensureRestartQuestion(db: Database, item: WorkItemRecord, now: number): boolean {
  const hold = restartHold(db, item);
  if (hold === null) return false;
  if (restartQuestionStands(db, item) || restartQuestionQueued(db, item.id)) return true;
  reenqueueJob(db, {
    queue: "item.ask",
    jobKey: `restart-ask:${item.id}:${hold.requestedAt}`,
    payload: {
      itemId: item.id,
      kind: "agent",
      reason: "restart",
      body: RESTART_QUESTION,
      options: ["Start again"],
    },
    now,
  });
  return true;
}
