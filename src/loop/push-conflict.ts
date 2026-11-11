import type { Database } from "bun:sqlite";
import { emitJobReady, getWorkItemSteps, recordRebaseReturnSteps, sqliteDb } from "../db";
import { rebaseBudgetForSteps } from "../merge";
import { askSteps, restartSteps } from "./operations";

/** What the agent hears when its candidate no longer rebases onto the branch on GitHub. */
export function pushConflictHandoff(branch: string, files: readonly string[]): string {
  const listed = files.length ? `:\n\n${files.map((file) => `- \`${file}\``).join("\n")}` : ".";
  return `\`${branch}\` moved on GitHub while you worked, so Paws could not push your last turn. Paws tried to rebase your commits onto it, and they conflict${listed}\n\nYour checkout now starts from the branch as it is on GitHub. Make your change again on top of it, resolve those conflicts so the change still does what the issue asks, and run the checks again.`;
}

/**
 * The runner rebased a rejected candidate onto its moved branch and the rebase conflicted
 * (PAS-886): the item goes back to the agent with a "conflict" restart naming the files, and no
 * question opens until the shared rebase budget is spent. Returns false for stale owners.
 */
export async function restartForPushConflict(
  db: Database,
  itemId: string,
  input: { branch: string; files: readonly string[]; now: number },
): Promise<boolean> {
  const store = sqliteDb(db);
  let armed = false;
  const handled = await store.transaction(function* (q) {
    const item = yield* getWorkItemSteps(q, itemId);
    if (!item || item.cancelRequested || item.state !== "running") return false;
    const conflict = { base: null, files: input.files, reason: "push" as const };
    const budget = yield* rebaseBudgetForSteps(q, itemId, conflict, input.now);
    if (!budget.allowed) {
      if (!item.sessionKey) return false;
      yield* askSteps(
        q,
        { itemId, runId: item.currentRunId, sessionId: item.sessionKey, version: item.version },
        "ci-help",
        `${budget.message} Reply with guidance to resolve the conflicts on \`${input.branch}\` and continue, or stop the task.`,
        { now: input.now, reason: "rebase_budget_spent" },
      );
      return true;
    }
    const job = yield* restartSteps(q, item, {
      reason: "conflict",
      body: pushConflictHandoff(input.branch, input.files),
      now: input.now,
    });
    if (job === null) return false;
    armed = job.armed;
    yield* recordRebaseReturnSteps(q, {
      itemId,
      jobId: job.id,
      candidate: null,
      ...conflict,
      recordedAt: input.now,
    });
    return true;
  });
  if (armed) emitJobReady(store);
  return handled;
}
