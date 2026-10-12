import type { Database } from "bun:sqlite";
import type { RepositoryBinding } from "../core";
import { immediate } from "./tx";

export function getWorkItemRepository(db: Database, itemId: string): RepositoryBinding | null {
  return db
    .query<RepositoryBinding, [string]>(
      "SELECT owner, repo, remote_url AS remoteUrl FROM work_item_repository WHERE item_id = ?",
    )
    .get(itemId);
}

export function bindWorkItemRepository(
  db: Database,
  itemId: string,
  repository: RepositoryBinding,
): RepositoryBinding {
  if (
    !/^[a-z0-9_.-]+$/i.test(repository.owner) ||
    !/^[a-z0-9_.-]+$/i.test(repository.repo) ||
    [repository.owner, repository.repo].some((value) => value === "." || value === "..") ||
    repository.remoteUrl.trim().length === 0
  ) {
    throw new Error("A work item repository requires an owner, repository name and remote URL");
  }
  return immediate(db, () => {
    db.run(
      "INSERT OR IGNORE INTO work_item_repository (item_id, owner, repo, remote_url) VALUES (?, ?, ?, ?)",
      [itemId, repository.owner, repository.repo, repository.remoteUrl],
    );
    const saved = getWorkItemRepository(db, itemId);
    if (
      saved === null ||
      saved.owner !== repository.owner ||
      saved.repo !== repository.repo ||
      saved.remoteUrl !== repository.remoteUrl
    ) {
      throw new Error("A work item's repository cannot change after it has been bound");
    }
    return saved;
  });
}
