import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import type { TaskMode } from "../core";
import { orm } from "./orm";
import { taskRequest } from "./schema";
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
  const row = orm(db)
    .select({ classification: taskRequest.classification })
    .from(taskRequest)
    .where(eq(taskRequest.taskKey, taskKey))
    .get();
  return row ? (JSON.parse(row.classification) as StoredTaskClassification) : null;
}

export function saveTaskClassification(
  db: Database,
  taskKey: string,
  classification: StoredTaskClassification,
): void {
  orm(db)
    .insert(taskRequest)
    .values({ taskKey, classification: JSON.stringify(classification) })
    .onConflictDoNothing()
    .run();
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
    orm(db)
      .update(taskRequest)
      .set({
        classification: JSON.stringify({
          mode: "code",
          redirect: { taskKey, itemId: input.itemId },
        }),
      })
      .where(eq(taskRequest.taskKey, input.taskKey))
      .run();
  });
}
