/** Agent returns allowed per item until a person replies, including unknown-main conflicts. */
export const MAX_REBASE_RETURNS = 3;

/** A conflict with main: the main commit and files, when known. */
export type RebaseConflict = {
  base: string | null;
  files: readonly string[] | null;
};

/** A return already spent on a conflict, oldest first. */
export type SpentRebaseReturn = RebaseConflict & { recordedAt: number | null };

export type RebaseBudget = { allowed: true; spent: number } | { allowed: false; message: string };

/** Every conflict return spends the item's budget until a person replies. */
export function rebaseBudget(
  spent: readonly SpentRebaseReturn[],
  conflict: RebaseConflict,
): RebaseBudget {
  if (spent.length >= MAX_REBASE_RETURNS)
    return {
      allowed: false,
      message: `The branch still conflicts with main after ${spent.length} attempts to resolve the conflict.${describe([...spent, conflict])}`,
    };
  return { allowed: true, spent: spent.length };
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
