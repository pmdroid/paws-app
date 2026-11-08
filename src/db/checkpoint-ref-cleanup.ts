import type { Database } from "bun:sqlite";
import { asc, eq } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";

/** Items whose checkpoint ref still waits to be deleted, longest-ended first. */
export function* endedCheckpointRefItemsSteps(q: Q) {
  const { checkpointRefCleanup } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ itemId: checkpointRefCleanup.itemId })
      .from(checkpointRefCleanup)
      .orderBy(asc(checkpointRefCleanup.endedAt), asc(checkpointRefCleanup.itemId)),
  );
  return rows.map((row) => row.itemId);
}

export function endedCheckpointRefItems(db: Database): string[] {
  return settled(sqliteDb(db).run(endedCheckpointRefItemsSteps));
}

export function* clearCheckpointRefCleanupSteps(q: Q, itemId: string) {
  const { checkpointRefCleanup } = q.t;
  yield* q.exec(q.orm.delete(checkpointRefCleanup).where(eq(checkpointRefCleanup.itemId, itemId)));
}

export function clearCheckpointRefCleanup(db: Database, itemId: string): void {
  settled(sqliteDb(db).run((q) => clearCheckpointRefCleanupSteps(q, itemId)));
}
