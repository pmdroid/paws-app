import type { Database } from "bun:sqlite";
import { checkpointRef, isTerminalWorkItemState, type RepositoryBinding } from "../core";
import {
  branchHeldByOtherItem,
  branchRunnerWork,
  clearCheckpointRefCleanup,
  endedCheckpointRefItems,
  getWorkItem,
  getWorkItemRepository,
  runTeardownOwner,
} from "../db";
import { journalCaught } from "../journal";

export async function deleteEndedCheckpointRef(input: {
  db: Database;
  itemId: string;
  remove: (repository: RepositoryBinding, ref: string) => Promise<boolean>;
}): Promise<"deleted" | "absent" | "kept" | "deferred"> {
  const item = getWorkItem(input.db, input.itemId);
  if (!item?.branchName || !isTerminalWorkItemState(item.state)) return "kept";
  if (branchHeldByOtherItem(input.db, item.branchName, item.id)) return "kept";
  const executions = branchRunnerWork(input.db, item.branchName);
  if (executions.some((row) => row.endedAt === null || runTeardownOwner(input.db, row.runId)))
    return "deferred";
  const repository = getWorkItemRepository(input.db, item.id);
  if (!repository) return "kept";
  return (await input.remove(repository, checkpointRef(item.branchName))) ? "deleted" : "absent";
}

export async function sweepCheckpointRefs(input: {
  db: Database;
  remove: (repository: RepositoryBinding, ref: string) => Promise<boolean>;
  signal?: AbortSignal;
}): Promise<void> {
  for (const itemId of endedCheckpointRefItems(input.db)) {
    input.signal?.throwIfAborted();
    try {
      const outcome = await deleteEndedCheckpointRef({
        db: input.db,
        itemId,
        remove: input.remove,
      });
      if (outcome !== "deferred") clearCheckpointRefCleanup(input.db, itemId);
    } catch (error) {
      input.signal?.throwIfAborted();
      journalCaught(error, "checkpoint-ref.sweepCheckpointRefs", itemId, "retried next sweep");
    }
  }
}
