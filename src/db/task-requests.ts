import type { Database } from "bun:sqlite";
import type { TaskMode } from "../core";
import { immediate } from "./tx";

export type StoredTaskClassification =
  | {
      mode: TaskMode;
      repository?: boolean;
      redirect?: { taskKey: string; itemId: string };
      context?: string;
      sourceItemId?: string;
    }
  | { mode: "clarify"; question: string };

export function getTaskClassification(
  db: Database,
  taskKey: string,
): StoredTaskClassification | null {
  const row = db
    .query<{ classification: string }, [string]>(
      "SELECT classification FROM task_request WHERE task_key = ?",
    )
    .get(taskKey);
  return row ? (JSON.parse(row.classification) as StoredTaskClassification) : null;
}

export function saveTaskClassification(
  db: Database,
  taskKey: string,
  classification: StoredTaskClassification,
): void {
  db.run("INSERT OR IGNORE INTO task_request (task_key, classification) VALUES (?, ?)", [
    taskKey,
    JSON.stringify(classification),
  ]);
}

export function resolveTaskClassification(
  db: Database,
  input: { taskKey: string; itemId: string; context: string },
): void {
  immediate(db, () => {
    const taskKey = `resolved:${input.taskKey}`;
    saveTaskClassification(db, taskKey, {
      mode: "code",
      context: input.context,
      sourceItemId: input.itemId,
    });
    db.run("UPDATE task_request SET classification = ? WHERE task_key = ?", [
      JSON.stringify({ mode: "code", redirect: { taskKey, itemId: input.itemId } }),
      input.taskKey,
    ]);
  });
}
