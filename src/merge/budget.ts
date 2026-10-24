/** Returns allowed in a row for conflicts with the same main commit (or the same files). */
export const MAX_REBASE_RETURNS = 3;
/** Returns allowed in any hour, whatever caused them, so a busy main cannot loop forever. */
export const MAX_REBASE_RETURNS_PER_HOUR = 6;
export const REBASE_RETURN_WINDOW_MS = 60 * 60 * 1000;

/** A conflict with main: the main commit and files, when known. */
export type RebaseConflict = {
  base: string | null;
  files: readonly string[] | null;
};

/** A return already spent on a conflict, oldest first. */
export type SpentRebaseReturn = RebaseConflict & { recordedAt: number | null };

export type RebaseBudget = { allowed: true; spent: number } | { allowed: false; message: string };

/**
 * Whether a new conflict may go back to the agent. A return counts against
 * the budget only when it repeats the return before it: the same main commit,
 * or the same files when a commit is unknown. A conflict caused by a newer
 * main starts a fresh attempt. The hourly cap counts every return.
 */
export function rebaseBudget(
  spent: readonly SpentRebaseReturn[],
  conflict: RebaseConflict,
  now: number,
): RebaseBudget {
  const streak: RebaseConflict[] = [];
  let next: RebaseConflict = conflict;
  for (let index = spent.length - 1; index >= 0; index--) {
    const previous = spent[index]!;
    if (!sameConflict(previous, next)) break;
    streak.unshift(previous);
    next = previous;
  }
  if (streak.length >= MAX_REBASE_RETURNS)
    return {
      allowed: false,
      message: `The branch still conflicts with main after ${MAX_REBASE_RETURNS} attempts to resolve the conflict.${describe([...streak, conflict])}`,
    };
  const recent = spent.filter(
    (row) => row.recordedAt !== null && row.recordedAt > now - REBASE_RETURN_WINDOW_MS,
  );
  if (recent.length >= MAX_REBASE_RETURNS_PER_HOUR)
    return {
      allowed: false,
      message: `The branch conflicted with main ${recent.length + 1} times within an hour.${describe([...recent, conflict])}`,
    };
  return { allowed: true, spent: streak.length };
}

function sameConflict(a: RebaseConflict, b: RebaseConflict): boolean {
  if (a.base && b.base) return a.base === b.base;
  if (a.files?.length && b.files?.length) return sameFiles(a.files, b.files);
  return true;
}

function sameFiles(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((file) => right.has(file));
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
