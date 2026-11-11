import type { Database } from "bun:sqlite";
import { aliasedTable, and, asc, desc, eq, gt, lte, or, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps, type Db } from "./db";
import { jsonText, jsonValue } from "./json-text";

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

export function* saveCandidatePathsSteps(
  q: Q,
  input: { itemId: string; head: string; paths: readonly string[]; recordedAt: number },
) {
  const { candidatePaths } = q.t;
  yield* q.exec(
    q.orm
      .insert(candidatePaths)
      .values({
        itemId: input.itemId,
        headSha: input.head,
        paths: jsonValue(q, [...new Set(input.paths)].sort()),
        recordedAt: input.recordedAt,
      })
      .onConflictDoUpdate({
        target: [candidatePaths.itemId, candidatePaths.headSha],
        set: { paths: sql`excluded.paths`, recordedAt: sql`excluded.recorded_at` },
      }),
  );
}

/** Records every path a candidate head changes since its base. A repeat of the head replaces it. */
export async function saveCandidatePaths(
  store: Db,
  input: { itemId: string; head: string; paths: readonly string[]; recordedAt: number },
): Promise<void> {
  await store.run((q) => saveCandidatePathsSteps(q, input));
}

export function* getCandidatePathsSteps(q: Q, itemId: string, head: string) {
  const { candidatePaths } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ paths: jsonText(q, candidatePaths.paths) })
      .from(candidatePaths)
      .where(and(eq(candidatePaths.itemId, itemId), eq(candidatePaths.headSha, head))),
  );
  if (row === undefined) return null;
  const paths: unknown = JSON.parse(row.paths);
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string"))
    throw new Error("Invalid stored candidate paths");
  return paths as string[];
}

/** Exact-head changed paths. Unknown paths must never be mistaken for an empty change. */
export async function getCandidatePaths(
  store: Db,
  itemId: string,
  head: string,
): Promise<string[] | null> {
  return store.run((q) => getCandidatePathsSteps(q, itemId, head));
}

/** Same-millisecond candidates of an item are told apart by head, the table's natural key. */
export function* latestCandidatePathsSteps(q: Q): Steps<Map<string, string[]>> {
  const { candidatePaths } = q.t;
  const later = aliasedTable(candidatePaths, "later");
  const latest = q.orm
    .select({ head: later.headSha })
    .from(later)
    .where(eq(later.itemId, candidatePaths.itemId))
    .orderBy(desc(later.recordedAt), desc(later.headSha))
    .limit(1);
  const rows = yield* q.all(
    q.orm
      .select({ itemId: candidatePaths.itemId, paths: jsonText(q, candidatePaths.paths) })
      .from(candidatePaths)
      .where(eq(candidatePaths.headSha, sql`(${latest})`)),
  );
  return new Map(rows.map((row) => [row.itemId, JSON.parse(row.paths) as string[]]));
}

/**
 * The paths of each item's latest candidate, by item id. An item Paws has not published a
 * candidate for has no entry: its files are unknown.
 */
export async function latestCandidatePaths(store: Db): Promise<Map<string, string[]>> {
  return store.run((q) => latestCandidatePathsSteps(q));
}

/**
 * The paths of the item's candidate `head`, or else of the latest candidate it published by `at`.
 * Later publications never change it, so a past conflict or merge keeps the files it had.
 */
function* candidatePathsAtSteps(q: Q, itemId: string, head: string | null, at: number) {
  const { candidatePaths } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ paths: jsonText(q, candidatePaths.paths) })
      .from(candidatePaths)
      .where(
        and(
          eq(candidatePaths.itemId, itemId),
          or(eq(candidatePaths.headSha, head ?? ""), lte(candidatePaths.recordedAt, at)),
        ),
      )
      .orderBy(
        desc(sql`${candidatePaths.headSha} = ${head ?? ""}`),
        desc(candidatePaths.recordedAt),
        desc(candidatePaths.headSha),
      )
      .limit(1),
  );
  return row ? (JSON.parse(row.paths) as string[]) : [];
}

/** Lower-case `owner/repo`, the key hot files and the scheduler compare repositories by. */
export function repositoryKey(owner: string, repo: string): string {
  return `${owner}/${repo}`.toLowerCase();
}

export function* hotFilesSteps(q: Q, now: number): Steps<HotFile[]> {
  const { rebaseReturn, remoteMergeFact, workItem, workItemRepository } = q.t;
  const since = now - HOT_FILE_WINDOW_MS;
  const returns = yield* q.all(
    q.orm
      .select({
        itemId: rebaseReturn.itemId,
        identifier: workItem.linearIdentifier,
        owner: workItemRepository.owner,
        repo: workItemRepository.repo,
        candidate: rebaseReturn.candidate,
        files: jsonText(q, rebaseReturn.files),
        at: rebaseReturn.recordedAt,
      })
      .from(rebaseReturn)
      .innerJoin(workItem, eq(workItem.id, rebaseReturn.itemId))
      .innerJoin(workItemRepository, eq(workItemRepository.itemId, rebaseReturn.itemId))
      .where(gt(rebaseReturn.recordedAt, since))
      .orderBy(asc(rebaseReturn.recordedAt), asc(rebaseReturn.jobId)),
  );
  if (!returns.length) return [];
  // Each merge counts the candidate it merged: the last one published before its confirmation.
  const confirmed = yield* q.all(
    q.orm
      .select({
        itemId: remoteMergeFact.itemId,
        owner: remoteMergeFact.repositoryOwner,
        repo: remoteMergeFact.repositoryName,
        at: remoteMergeFact.confirmedAt,
      })
      .from(remoteMergeFact)
      .where(gt(remoteMergeFact.confirmedAt, since)),
  );
  const merges = [];
  for (const merge of confirmed)
    merges.push({ ...merge, paths: yield* candidatePathsAtSteps(q, merge.itemId, null, merge.at) });
  const found = new Map<string, HotFile>();
  for (const row of returns) {
    const at = row.at!;
    const key = repositoryKey(row.owner, row.repo);
    let files = row.files === null ? null : (JSON.parse(row.files) as string[]);
    if (files === null) {
      const merged = new Set(
        merges
          .filter(
            (merge) =>
              merge.itemId !== row.itemId &&
              merge.at <= at &&
              repositoryKey(merge.owner, merge.repo) === key,
          )
          .flatMap((merge) => merge.paths),
      );
      files = (yield* candidatePathsAtSteps(q, row.itemId, row.candidate, at)).filter((path) =>
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

/**
 * Files that caused merge-queue conflicts in the window before `now`, from conflict restarts,
 * most conflicts first. A restart records its conflicting files when the lane's rebase named
 * them. A restart without them, such as a GitHub merge queue removal, counts the files the
 * candidate it returned shares with pull requests that merged into the same repository before
 * it.
 */
export function hotFiles(db: Database, now: number): HotFile[] {
  return settled(sqliteDb(db).run((q) => hotFilesSteps(q, now)));
}
