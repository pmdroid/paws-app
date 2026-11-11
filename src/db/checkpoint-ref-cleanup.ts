import { asc, eq } from "drizzle-orm";
import { type Q, type Db } from "./db";

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

export async function endedCheckpointRefItems(store: Db): Promise<string[]> {
  return store.run((q) => endedCheckpointRefItemsSteps(q));
}

export function* clearCheckpointRefCleanupSteps(q: Q, itemId: string) {
  const { checkpointRefCleanup } = q.t;
  yield* q.exec(q.orm.delete(checkpointRefCleanup).where(eq(checkpointRefCleanup.itemId, itemId)));
}

export async function clearCheckpointRefCleanup(store: Db, itemId: string): Promise<void> {
  await store.run((q) => clearCheckpointRefCleanupSteps(q, itemId));
}
