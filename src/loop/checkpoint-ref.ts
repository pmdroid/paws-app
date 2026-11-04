import type { Database } from "bun:sqlite";
import { checkpointRef, isTerminalWorkItemState, type RepositoryBinding } from "../core";
import { getWorkItem, getWorkItemRepository } from "../db";
import { journalCaught } from "../journal";

export async function deleteEndedCheckpointRef(input: {
  db: Database;
  itemId: string;
  remove: (repository: RepositoryBinding, ref: string) => Promise<boolean>;
}): Promise<"deleted" | "absent" | "kept"> {
  const item = getWorkItem(input.db, input.itemId);
  if (!item?.branchName || !isTerminalWorkItemState(item.state)) return "kept";
  const continued = input.db
    .query(
      `SELECT 1 FROM item_continuation c JOIN work_item i ON i.id = c.item_id
       WHERE c.previous_item_id = ? AND c.branch = ?
         AND i.state NOT IN ('completed','merged','cancelled')`,
    )
    .get(item.id, item.branchName);
  if (continued) return "kept";
  const repository = getWorkItemRepository(input.db, item.id);
  if (!repository) return "kept";
  return (await input.remove(repository, checkpointRef(item.branchName))) ? "deleted" : "absent";
}

export async function sweepCheckpointRefs(input: {
  db: Database;
  remove: (repository: RepositoryBinding, ref: string) => Promise<boolean>;
  signal?: AbortSignal;
}): Promise<void> {
  const ended = input.db
    .query<{ itemId: string }, []>(
      "SELECT item_id AS itemId FROM checkpoint_ref_cleanup ORDER BY ended_at, item_id",
    )
    .all();
  for (const { itemId } of ended) {
    input.signal?.throwIfAborted();
    try {
      await deleteEndedCheckpointRef({ db: input.db, itemId, remove: input.remove });
      input.db.run("DELETE FROM checkpoint_ref_cleanup WHERE item_id=?", [itemId]);
    } catch (error) {
      input.signal?.throwIfAborted();
      journalCaught(error, "checkpoint-ref.sweepCheckpointRefs", itemId, "retried next sweep");
    }
  }
}
