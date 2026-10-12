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

export function saveWorkItemRepositoryQuestion(
  db: Database,
  itemId: string,
  questionId: string,
  candidates: readonly RepositoryBinding[],
): void {
  db.run(
    `INSERT INTO work_item_repository_question (item_id, question_id, candidates) VALUES (?, ?, ?)
    ON CONFLICT (item_id) DO UPDATE SET question_id = excluded.question_id, candidates = excluded.candidates`,
    [itemId, questionId, JSON.stringify(candidates)],
  );
}

export function getWorkItemRepositoryAnswer(
  db: Database,
  itemId: string,
): { answer: string; candidates: readonly RepositoryBinding[] } | null {
  const row = db
    .query<{ answer: string; candidates: string }, [string]>(
      `SELECT q.answer, r.candidates FROM work_item_repository_question r
      JOIN question q ON q.id = r.question_id
      WHERE r.item_id = ? AND q.status = 'answered' AND q.answer IS NOT NULL`,
    )
    .get(itemId);
  return row === null ? null : { answer: row.answer, candidates: JSON.parse(row.candidates) };
}

export function isWorkItemRepositoryQuestion(
  db: Database,
  itemId: string,
  questionId: string,
): boolean {
  return (
    db
      .query<{ id: string }, [string, string]>(
        "SELECT question_id AS id FROM work_item_repository_question WHERE item_id = ? AND question_id = ?",
      )
      .get(itemId, questionId) !== null
  );
}
