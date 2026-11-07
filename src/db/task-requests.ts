import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import type { TaskMode } from "../core";
import { settled, sqliteDb, type Q } from "./db";

export type StoredTaskClassification =
  | {
      mode: TaskMode;
      repository?: boolean;
      redirect?: { taskKey: string; itemId: string };
      context?: string;
      sourceItemId?: string;
    }
  | { mode: "clarify"; question: string };

function stored(q: Q, classification: StoredTaskClassification): unknown {
  return q.dialect === "sqlite" ? JSON.stringify(classification) : classification;
}

export function* getTaskClassificationSteps(q: Q, taskKey: string) {
  const { taskRequest } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ classification: taskRequest.classification })
      .from(taskRequest)
      .where(eq(taskRequest.taskKey, taskKey)),
  );
  if (!row) return null;
  return (
    q.dialect === "sqlite" ? JSON.parse(row.classification as string) : row.classification
  ) as StoredTaskClassification;
}

export function getTaskClassification(
  db: Database,
  taskKey: string,
): StoredTaskClassification | null {
  return settled(sqliteDb(db).run((q) => getTaskClassificationSteps(q, taskKey)));
}

export function* saveTaskClassificationSteps(
  q: Q,
  taskKey: string,
  classification: StoredTaskClassification,
) {
  const { taskRequest } = q.t;
  yield* q.exec(
    q.orm
      .insert(taskRequest)
      .values({ taskKey, classification: stored(q, classification) })
      .onConflictDoNothing(),
  );
}

export function saveTaskClassification(
  db: Database,
  taskKey: string,
  classification: StoredTaskClassification,
): void {
  settled(sqliteDb(db).run((q) => saveTaskClassificationSteps(q, taskKey, classification)));
}

export function* resolveTaskClassificationSteps(
  q: Q,
  input: { taskKey: string; itemId: string; context: string },
) {
  const { taskRequest } = q.t;
  const taskKey = `resolved:${input.taskKey}`;
  yield* saveTaskClassificationSteps(q, taskKey, {
    mode: "code",
    context: input.context,
    sourceItemId: input.itemId,
  });
  yield* q.exec(
    q.orm
      .update(taskRequest)
      .set({
        classification: stored(q, { mode: "code", redirect: { taskKey, itemId: input.itemId } }),
      })
      .where(eq(taskRequest.taskKey, input.taskKey)),
  );
}

export function resolveTaskClassification(
  db: Database,
  input: { taskKey: string; itemId: string; context: string },
): void {
  settled(sqliteDb(db).transaction((q) => resolveTaskClassificationSteps(q, input)));
}
