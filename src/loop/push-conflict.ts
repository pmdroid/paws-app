import type { Database } from "bun:sqlite";
import { getWorkItem, immediate } from "../db";
import { restart } from "./operations";

/** What the agent hears when its candidate no longer rebases onto the branch on GitHub. */
export function pushConflictHandoff(branch: string, files: readonly string[]): string {
  const listed = files.length ? `:\n\n${files.map((file) => `- \`${file}\``).join("\n")}` : ".";
  return `\`${branch}\` moved on GitHub while you worked, so Paws could not push your last turn. Paws tried to rebase your commits onto it, and they conflict${listed}\n\nYour checkout now starts from the branch as it is on GitHub. Make your change again on top of it, resolve those conflicts so the change still does what the issue asks, and run the checks again.`;
}

/**
 * The runner rebased a rejected candidate onto its moved branch and the rebase conflicted
 * (PAS-886): the item goes back to the agent with a "conflict" restart naming the files, and no
 * question opens. Returns false when the item cannot restart from where it is.
 */
export function restartForPushConflict(
  db: Database,
  itemId: string,
  input: { branch: string; files: readonly string[]; now: number },
): boolean {
  return immediate(db, () => {
    const item = getWorkItem(db, itemId);
    if (!item || item.cancelRequested || item.state !== "running") return false;
    return (
      restart(db, item, {
        reason: "conflict",
        source: "infrastructure",
        body: pushConflictHandoff(input.branch, input.files),
        now: input.now,
      }).kind !== "skipped"
    );
  });
}
