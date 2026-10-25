import type { Checkpoint, GitCommitPolicy } from "../core";

type LegacyCommitPolicy = Pick<GitCommitPolicy, "bot"> & {
  projectLead?: unknown;
  taskSteerer?: GitCommitPolicy["credit"];
};

/**
 * Parse a stored checkpoint. Runs recorded before the single-credit policy stored
 * `projectLead` and `taskSteerer`; only the task steerer, the delegating member, is credited now.
 */
export function readCheckpoint(raw: string): Checkpoint {
  const checkpoint = JSON.parse(raw) as Checkpoint;
  const stored = checkpoint.commitPolicy as GitCommitPolicy | LegacyCommitPolicy | undefined;
  if (!stored || typeof stored !== "object" || "credit" in stored) return checkpoint;
  return { ...checkpoint, commitPolicy: { bot: stored.bot, credit: stored.taskSteerer ?? null } };
}
