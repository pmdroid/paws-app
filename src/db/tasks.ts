import type { Database } from "bun:sqlite";
import type { TaskMode } from "../core";
import { immediate } from "./tx";
import { applyWorkItemEvent, getWorkItem } from "./items";
import { enqueueOutboxOnce } from "./outbox";
import { markRun } from "./runs";

export function getTaskMode(db: Database, itemId: string): TaskMode | null {
  return (
    db
      .query<{ mode: TaskMode }, [string]>("SELECT mode FROM work_item_task WHERE item_id = ?")
      .get(itemId)?.mode ?? null
  );
}

export function saveTaskMode(db: Database, itemId: string, mode: TaskMode): TaskMode {
  return immediate(db, () => {
    db.run("INSERT OR IGNORE INTO work_item_task (item_id, mode) VALUES (?, ?)", [itemId, mode]);
    const saved = getTaskMode(db, itemId);
    if (saved !== mode) throw new Error("Task mode already selected");
    return saved;
  });
}

export function completeAnswerTask(
  db: Database,
  itemId: string,
  response: string,
  now = Date.now(),
): void {
  if (!response.trim()) throw new Error("Answer completion requires a prepared response");
  immediate(db, () => {
    const item = getWorkItem(db, itemId);
    if (!item || item.state !== "running" || item.cancelRequested)
      throw new Error("Task is no longer running");
    if (getTaskMode(db, itemId) !== "answer")
      throw new Error("Only answer tasks complete at the response boundary");
    if (!item.sessionKey) throw new Error("Answer task has no session");
    db.run("UPDATE work_item_task SET response = ? WHERE item_id = ?", [response, itemId]);
    applyWorkItemEvent(db, itemId, "answer_completed");
    if (item.currentRunId) markRun(db, item.currentRunId, "ended", now);
    enqueueOutboxOnce(db, {
      target: "linear",
      op: "activity",
      orderingKey: item.sessionKey,
      idempotencyKey: `answer-completed:${itemId}`,
      payload: { sessionId: item.sessionKey, kind: "response", body: response },
      now,
    });
  });
}
