import { checkpointRef, isTerminalWorkItemState, type RepositoryBinding } from "../core";
import {
  branchHeldByOtherItemSteps,
  branchRunnerWorkSteps,
  clearCheckpointRefCleanupSteps,
  endedCheckpointRefItemsSteps,
  getWorkItemRepositorySteps,
  getWorkItemSteps,
  runTeardownOwnerSteps,
  type Db,
} from "../db";
import { journalCaught } from "../journal";

export async function deleteEndedCheckpointRef(input: {
  store: Db;
  itemId: string;
  remove: (repository: RepositoryBinding, ref: string) => Promise<boolean>;
}): Promise<"deleted" | "absent" | "kept" | "deferred"> {
  const target = await input.store.run(function* (q) {
    const item = yield* getWorkItemSteps(q, input.itemId);
    if (!item?.branchName || !isTerminalWorkItemState(item.state)) return "kept" as const;
    if (yield* branchHeldByOtherItemSteps(q, item.branchName, item.id)) return "kept" as const;
    for (const row of yield* branchRunnerWorkSteps(q, item.branchName))
      if (row.endedAt === null || (yield* runTeardownOwnerSteps(q, row.runId)))
        return "deferred" as const;
    const repository = yield* getWorkItemRepositorySteps(q, item.id);
    return repository ? { repository, branch: item.branchName } : ("kept" as const);
  });
  if (typeof target === "string") return target;
  return (await input.remove(target.repository, checkpointRef(target.branch)))
    ? "deleted"
    : "absent";
}

export async function sweepCheckpointRefs(input: {
  store: Db;
  remove: (repository: RepositoryBinding, ref: string) => Promise<boolean>;
  signal?: AbortSignal;
}): Promise<void> {
  for (const itemId of await input.store.run(endedCheckpointRefItemsSteps)) {
    input.signal?.throwIfAborted();
    try {
      const outcome = await deleteEndedCheckpointRef({
        store: input.store,
        itemId,
        remove: input.remove,
      });
      if (outcome !== "deferred")
        await input.store.run((q) => clearCheckpointRefCleanupSteps(q, itemId));
    } catch (error) {
      input.signal?.throwIfAborted();
      journalCaught(error, "checkpoint-ref.sweepCheckpointRefs", itemId, "retried next sweep");
    }
  }
}
