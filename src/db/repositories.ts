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
    ON CONFLICT (item_id) DO UPDATE SET question_id = excluded.question_id, candidates = excluded.candidates, chosen_repository = NULL`,
    [itemId, questionId, JSON.stringify(candidates)],
  );
}

export function getWorkItemRepositoryAnswer(
  db: Database,
  itemId: string,
): { questionId: string; answer: string; candidates: readonly RepositoryBinding[] } | null {
  const row = db
    .query<{ questionId: string; answer: string; candidates: string }, [string]>(
      `SELECT q.id AS questionId, q.answer, r.candidates FROM work_item_repository_question r
      JOIN question q ON q.id = r.question_id
      WHERE r.item_id = ? AND q.status = 'answered' AND q.answer IS NOT NULL`,
    )
    .get(itemId);
  return row === null
    ? null
    : { questionId: row.questionId, answer: row.answer, candidates: JSON.parse(row.candidates) };
}

export function rememberWorkItemRepositoryChoice(
  db: Database,
  itemId: string,
  questionId: string,
  repository: RepositoryBinding,
): boolean {
  return immediate(db, () => {
    const answer = getWorkItemRepositoryAnswer(db, itemId);
    if (answer === null || answer.questionId !== questionId) return false;
    if (!answer.candidates.some((candidate) => sameRepository(candidate, repository)))
      throw new Error("The chosen repository was not offered for this question");
    db.run(
      "UPDATE work_item_repository_question SET chosen_repository = ? WHERE item_id = ? AND question_id = ?",
      [JSON.stringify(repository), itemId, questionId],
    );
    return true;
  });
}

export function getWorkItemRepositoryChoice(
  db: Database,
  itemId: string,
): RepositoryBinding | null {
  const row = db
    .query<{ chosen: string }, [string]>(
      `SELECT r.chosen_repository AS chosen FROM work_item_repository_question r
      JOIN question q ON q.id = r.question_id
      WHERE r.item_id = ? AND q.status = 'answered' AND r.chosen_repository IS NOT NULL`,
    )
    .get(itemId);
  return row === null ? null : JSON.parse(row.chosen);
}

function sameRepository(left: RepositoryBinding, right: RepositoryBinding): boolean {
  return (
    left.owner === right.owner && left.repo === right.repo && left.remoteUrl === right.remoteUrl
  );
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
