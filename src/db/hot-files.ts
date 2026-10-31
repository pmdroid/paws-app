import type { Database } from "bun:sqlite";

/** Conflict restarts this recent make their files hot. */
export const HOT_FILE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** A file that sent work back for a merge-queue conflict within {@link HOT_FILE_WINDOW_MS}. */
export type HotFile = {
  /** `owner/repo` as the item is bound to it. */
  repository: string;
  path: string;
  /** Conflict restarts that named or touched the file. */
  conflicts: number;
  /** Linear identifiers of the items those restarts sent back. */
  items: string[];
};

/** Records every path a candidate head changes since its base. A repeat of the head replaces it. */
export function saveCandidatePaths(
  db: Database,
  input: { itemId: string; head: string; paths: readonly string[]; recordedAt: number },
): void {
  db.run(
    `INSERT INTO candidate_paths (item_id, head_sha, paths, recorded_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (item_id, head_sha) DO UPDATE SET paths = excluded.paths,
       recorded_at = excluded.recorded_at`,
    [input.itemId, input.head, JSON.stringify([...new Set(input.paths)].sort()), input.recordedAt],
  );
}

/** Exact-head changed paths. Unknown paths must never be mistaken for an empty change. */
export function getCandidatePaths(db: Database, itemId: string, head: string): string[] | null {
  const row = db
    .query<{ paths: string }, [string, string]>(
      "SELECT paths FROM candidate_paths WHERE item_id = ? AND head_sha = ?",
    )
    .get(itemId, head);
  if (row === null) return null;
  const paths: unknown = JSON.parse(row.paths);
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string"))
    throw new Error("Invalid stored candidate paths");
  return paths;
}

/**
 * The paths of each item's latest candidate, by item id. An item Paws has not published a
 * candidate for has no entry: its files are unknown.
 */
export function latestCandidatePaths(db: Database): Map<string, string[]> {
  return new Map(
    db
      .query<{ itemId: string; paths: string }, []>(
        `SELECT c.item_id AS itemId, c.paths FROM candidate_paths c
         WHERE c.rowid = (SELECT l.rowid FROM candidate_paths l WHERE l.item_id = c.item_id
           ORDER BY l.recorded_at DESC, l.rowid DESC LIMIT 1)`,
      )
      .all()
      .map((row) => [row.itemId, JSON.parse(row.paths) as string[]]),
  );
}

/**
 * The paths of the item's candidate `head`, or else of the latest candidate it published by `at`.
 * Later publications never change it, so a past conflict or merge keeps the files it had.
 */
function candidatePathsAt(db: Database, itemId: string, head: string | null, at: number): string[] {
  const row = db
    .query<{ paths: string }, [string, string, number, string]>(
      `SELECT paths FROM candidate_paths WHERE item_id = ? AND (head_sha = ? OR recorded_at <= ?)
       ORDER BY head_sha = ? DESC, recorded_at DESC, rowid DESC LIMIT 1`,
    )
    .get(itemId, head ?? "", at, head ?? "");
  return row ? (JSON.parse(row.paths) as string[]) : [];
}

/** Lower-case `owner/repo`, the key hot files and the scheduler compare repositories by. */
export function repositoryKey(owner: string, repo: string): string {
  return `${owner}/${repo}`.toLowerCase();
}

/**
 * Files that caused merge-queue conflicts in the window before `now`, from conflict restarts,
 * most conflicts first. A restart records its conflicting files when the lane's rebase named
 * them. A restart without them, such as a GitHub merge queue removal, counts the files the
 * candidate it returned shares with pull requests that merged into the same repository before
 * it.
 */
export function hotFiles(db: Database, now: number): HotFile[] {
  const since = now - HOT_FILE_WINDOW_MS;
  const returns = db
    .query<
      {
        itemId: string;
        identifier: string | null;
        owner: string;
        repo: string;
        candidate: string | null;
        files: string | null;
        at: number;
      },
      [number]
    >(
      `SELECT r.item_id AS itemId, i.linear_identifier AS identifier, b.owner, b.repo,
       r.candidate, r.files,
       r.recorded_at AS at
       FROM rebase_return r JOIN work_item i ON i.id = r.item_id
       JOIN work_item_repository b ON b.item_id = r.item_id
       WHERE r.recorded_at > ? ORDER BY r.recorded_at, r.job_id`,
    )
    .all(since);
  if (!returns.length) return [];
  // Each merge counts the candidate it merged: the last one published before its confirmation.
  const merges = db
    .query<{ itemId: string; owner: string; repo: string; at: number }, [number]>(
      `SELECT item_id AS itemId, repository_owner AS owner, repository_name AS repo,
       confirmed_at AS at FROM remote_merge_fact WHERE confirmed_at > ?`,
    )
    .all(since)
    .map((merge) => ({ ...merge, paths: candidatePathsAt(db, merge.itemId, null, merge.at) }));
  const found = new Map<string, HotFile>();
  for (const row of returns) {
    const key = repositoryKey(row.owner, row.repo);
    let files = row.files === null ? null : (JSON.parse(row.files) as string[]);
    if (files === null) {
      const merged = new Set(
        merges
          .filter(
            (merge) =>
              merge.itemId !== row.itemId &&
              merge.at <= row.at &&
              repositoryKey(merge.owner, merge.repo) === key,
          )
          .flatMap((merge) => merge.paths),
      );
      files = candidatePathsAt(db, row.itemId, row.candidate, row.at).filter((path) =>
        merged.has(path),
      );
    }
    for (const path of new Set(files)) {
      const id = `${key}\0${path}`;
      const hot = found.get(id) ?? {
        repository: `${row.owner}/${row.repo}`,
        path,
        conflicts: 0,
        items: [],
      };
      hot.conflicts += 1;
      const name = row.identifier ?? row.itemId;
      if (!hot.items.includes(name)) hot.items.push(name);
      found.set(id, hot);
    }
  }
  return [...found.values()].sort(
    (left, right) =>
      right.conflicts - left.conflicts ||
      left.repository.localeCompare(right.repository) ||
      left.path.localeCompare(right.path),
  );
}
