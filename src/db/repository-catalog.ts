import type { Database } from "bun:sqlite";
import { immediate } from "./tx";

export type CatalogEntry = {
  owner: string;
  repo: string;
  remoteUrl: string;
  defaultBranch: string;
};

export function listRepositoryCatalog(db: Database): CatalogEntry[] {
  return db
    .query<CatalogEntry, []>(
      `SELECT owner, repo, remote_url AS remoteUrl, default_branch AS defaultBranch
       FROM repository_catalog ORDER BY repository`,
    )
    .all();
}

export async function refreshRepositoryCatalog(
  db: Database,
  list: () => Promise<readonly CatalogEntry[]>,
  now = Date.now(),
): Promise<boolean> {
  let entries: readonly CatalogEntry[];
  try {
    entries = await list();
  } catch {
    return false;
  }
  immediate(db, () => {
    db.run("DELETE FROM repository_catalog");
    for (const entry of entries)
      db.run(
        `INSERT OR REPLACE INTO repository_catalog(repository, owner, repo, remote_url, default_branch, refreshed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          `${entry.owner}/${entry.repo}`.toLowerCase(),
          entry.owner,
          entry.repo,
          entry.remoteUrl,
          entry.defaultBranch,
          now,
        ],
      );
  });
  return true;
}
