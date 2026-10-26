import type { Finding } from "../types";

/**
 * Head-side line ranges added or changed in `base..head`, by repository path.
 * Each range is `[first, last]`, 1-based and inclusive. A path that is absent
 * was not changed. A path with no ranges only lost lines.
 */
export type ChangedLines = ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>;

export type FindingLocation = { path: string; line: number };

/** `git diff` arguments whose output {@link parseChangedLines} reads. */
export function changedLinesDiffArgs(base: string, head: string): string[] {
  return [
    "-c",
    "core.quotepath=false",
    "diff",
    "--no-ext-diff",
    "--no-color",
    "--no-renames",
    "--unified=0",
    base,
    head,
    "--",
  ];
}

/** Read `git diff --unified=0` output into the head lines each file gained or changed. */
export function parseChangedLines(diff: string): ChangedLines {
  const changed = new Map<string, Array<readonly [number, number]>>();
  let current: Array<readonly [number, number]> | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = undefined;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trimEnd();
      if (target === "/dev/null") {
        current = undefined;
        continue;
      }
      const path = target.startsWith("b/") ? target.slice(2) : target;
      current = changed.get(path) ?? [];
      changed.set(path, current);
      continue;
    }
    if (current === undefined || !line.startsWith("@@ ")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    // A pure deletion `+N,0` sits between head lines N and N + 1.
    current.push(count > 0 ? [start, start + count - 1] : [Math.max(start, 1), start + 1]);
  }
  return changed;
}

/**
 * `path:line`, `path:line:column`, or `path:first-last` from a finding location.
 * Anything else, including a bare path, is unreadable and returns undefined.
 */
export function parseLocation(location: string): FindingLocation | undefined {
  const match = /^(.+?):(\d+)(?:-\d+|:\d+)?$/.exec(location.trim());
  if (!match) return undefined;
  let path = match[1]!.trim().replace(/^`|`$/g, "");
  if (path.startsWith("./")) path = path.slice(2);
  const line = Number(match[2]);
  if (path.length === 0 || path.startsWith("/") || line < 1) return undefined;
  return { path, line };
}

/**
 * A finding is pre-existing when its `path:line` is readable and that line was
 * not added or changed in `base..head`. Unknown changed lines, or an
 * unreadable location, keep the finding in the diff.
 */
export function isPreExisting(finding: Finding, changed: ChangedLines | undefined): boolean {
  if (changed === undefined) return false;
  const location = parseLocation(finding.location);
  if (location === undefined) return false;
  const ranges = rangesFor(changed, location.path);
  if (ranges === undefined) return true;
  return !ranges.some(([first, last]) => location.line >= first && location.line <= last);
}

/** Exact path, or the one changed path that ends with it when the reviewer dropped a prefix. */
function rangesFor(
  changed: ChangedLines,
  path: string,
): ReadonlyArray<readonly [number, number]> | undefined {
  const exact = changed.get(path);
  if (exact !== undefined) return exact;
  const suffixed = [...changed.keys()].filter((entry) => entry.endsWith(`/${path}`));
  return suffixed.length === 1 ? changed.get(suffixed[0]!) : undefined;
}
