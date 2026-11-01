/** Returns allowed in a row for known-main conflicts and genuine push conflicts. */
export const MAX_REBASE_RETURNS = 3;
/** Returns allowed in any hour, whatever caused them, so a busy main cannot loop forever. */
export const MAX_REBASE_RETURNS_PER_HOUR = 6;
export const REBASE_RETURN_WINDOW_MS = 60 * 60 * 1000;

/** A conflict with main: the main commit and files, when known. */
export type RebaseConflict = {
  base: string | null;
  reason?: "merge" | "github_queue" | "linear" | "push";
  files: readonly string[] | null;
};

/** A return already spent on a conflict, oldest first. */
export type SpentRebaseReturn = RebaseConflict & { recordedAt: number | null };

export type RebaseBudget = { allowed: true; spent: number } | { allowed: false; message: string };

/** Known-main returns share one consecutive budget until a person replies.
 * Push conflicts share that budget; other unknown-main returns count only toward the rolling hour. */
export function rebaseBudget(
  spent: readonly SpentRebaseReturn[],
  conflict: RebaseConflict,
  now: number,
): RebaseBudget {
  const upstream = conflict.reason === "push" ? "its upstream branch" : "main";
  const streak = spent.filter((row) => row.base !== null || row.reason === "push");
  if ((conflict.base !== null || conflict.reason === "push") && streak.length >= MAX_REBASE_RETURNS)
    return {
      allowed: false,
      message: `The branch still conflicts with ${upstream} after ${MAX_REBASE_RETURNS} attempts to resolve the conflict.${describe([...streak, conflict])}`,
    };
  const recent = spent.filter(
    (row) => row.recordedAt !== null && row.recordedAt > now - REBASE_RETURN_WINDOW_MS,
  );
  if (recent.length >= MAX_REBASE_RETURNS_PER_HOUR)
    return {
      allowed: false,
      message: `The branch conflicted with ${upstream} ${recent.length + 1} times within an hour.${describe([...recent, conflict])}`,
    };
  return { allowed: true, spent: streak.length };
}

function describe(conflicts: readonly RebaseConflict[]): string {
  const commits = unique(conflicts.flatMap((row) => (row.base ? [row.base.slice(0, 7)] : [])));
  const files = unique(conflicts.flatMap((row) => row.files ?? []));
  return [
    commits.length ? ` Main commits: ${commits.join(", ")}.` : "",
    files.length ? ` Conflicting files: ${files.join(", ")}.` : "",
  ].join("");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
