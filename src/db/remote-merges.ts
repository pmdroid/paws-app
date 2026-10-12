import type { Database } from "bun:sqlite";
import { immediate } from "./tx";

export type ConfirmedRemoteMerge = {
  itemId: string;
  repositoryOwner: string;
  repositoryName: string;
  pullNumber: number;
  pullUrl: string | null;
  mergeSha: string | null;
  confirmedAt: number;
};

export function getConfirmedRemoteMerge(db: Database, itemId: string): ConfirmedRemoteMerge | null {
  return (
    db
      .query<ConfirmedRemoteMerge, [string]>(
        `SELECT item_id AS itemId, repository_owner AS repositoryOwner,
                repository_name AS repositoryName, pull_number AS pullNumber,
                pull_url AS pullUrl, merge_sha AS mergeSha, confirmed_at AS confirmedAt
         FROM remote_merge_fact WHERE item_id = ?`,
      )
      .get(itemId) ?? null
  );
}

export function recordConfirmedRemoteMerge(
  db: Database,
  input: ConfirmedRemoteMerge,
): ConfirmedRemoteMerge {
  return immediate(db, () => {
    db.run(
      `INSERT INTO remote_merge_fact
         (item_id, repository_owner, repository_name, pull_number, pull_url, merge_sha, confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (item_id) DO NOTHING`,
      [
        input.itemId,
        input.repositoryOwner,
        input.repositoryName,
        input.pullNumber,
        input.pullUrl,
        input.mergeSha,
        input.confirmedAt,
      ],
    );
    const saved = getConfirmedRemoteMerge(db, input.itemId);
    if (
      saved === null ||
      saved.repositoryOwner !== input.repositoryOwner ||
      saved.repositoryName !== input.repositoryName ||
      saved.pullNumber !== input.pullNumber ||
      saved.mergeSha !== input.mergeSha
    )
      throw new Error("The confirmed remote merge conflicts with its saved task history.");
    return saved;
  });
}
