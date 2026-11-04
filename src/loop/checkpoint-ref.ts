import type { Database } from "bun:sqlite";
import { checkpointRef, isTerminalWorkItemState, type RepositoryBinding } from "../core";
import { getWorkItem, getWorkItemRepository } from "../db";

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
