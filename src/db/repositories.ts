import type { Database } from "bun:sqlite";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { RepositoryBinding } from "../core";
import { settled, sqliteDb, type Q, type Steps } from "./db";
import { orm } from "./orm";
import { question, workItemRepository, workItemRepositoryQuestion } from "./schema";
import { immediate } from "./tx";

export function* getWorkItemRepositorySteps(q: Q, itemId: string): Steps<RepositoryBinding | null> {
  const { workItemRepository: repositories } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        owner: repositories.owner,
        repo: repositories.repo,
        remoteUrl: repositories.remoteUrl,
      })
      .from(repositories)
      .where(eq(repositories.itemId, itemId)),
  );
  return row ?? null;
}

export function getWorkItemRepository(db: Database, itemId: string): RepositoryBinding | null {
  return settled(sqliteDb(db).run((q) => getWorkItemRepositorySteps(q, itemId)));
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
    orm(db)
      .insert(workItemRepository)
      .values({
        itemId,
        owner: repository.owner,
        repo: repository.repo,
        remoteUrl: repository.remoteUrl,
      })
      .onConflictDoNothing()
      .run();
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
  orm(db)
    .insert(workItemRepositoryQuestion)
    .values({ itemId, questionId, candidates: JSON.stringify(candidates) })
    .onConflictDoUpdate({
      target: workItemRepositoryQuestion.itemId,
      set: {
        questionId: sql`excluded.question_id`,
        candidates: sql`excluded.candidates`,
        chosenRepository: null,
      },
    })
    .run();
}

export function getWorkItemRepositoryAnswer(
  db: Database,
  itemId: string,
): { questionId: string; answer: string; candidates: readonly RepositoryBinding[] } | null {
  const row = orm(db)
    .select({
      questionId: question.id,
      answer: question.answer,
      candidates: workItemRepositoryQuestion.candidates,
    })
    .from(workItemRepositoryQuestion)
    .innerJoin(question, eq(question.id, workItemRepositoryQuestion.questionId))
    .where(
      and(
        eq(workItemRepositoryQuestion.itemId, itemId),
        eq(question.status, "answered"),
        isNotNull(question.answer),
      ),
    )
    .get();
  return row === undefined
    ? null
    : { questionId: row.questionId, answer: row.answer!, candidates: JSON.parse(row.candidates) };
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
    orm(db)
      .update(workItemRepositoryQuestion)
      .set({ chosenRepository: JSON.stringify(repository) })
      .where(
        and(
          eq(workItemRepositoryQuestion.itemId, itemId),
          eq(workItemRepositoryQuestion.questionId, questionId),
        ),
      )
      .run();
    return true;
  });
}

export function getWorkItemRepositoryChoice(
  db: Database,
  itemId: string,
): RepositoryBinding | null {
  const row = orm(db)
    .select({ chosen: workItemRepositoryQuestion.chosenRepository })
    .from(workItemRepositoryQuestion)
    .innerJoin(question, eq(question.id, workItemRepositoryQuestion.questionId))
    .where(
      and(
        eq(workItemRepositoryQuestion.itemId, itemId),
        eq(question.status, "answered"),
        isNotNull(workItemRepositoryQuestion.chosenRepository),
      ),
    )
    .get();
  return row === undefined ? null : JSON.parse(row.chosen!);
}

function sameRepository(left: RepositoryBinding, right: RepositoryBinding): boolean {
  return (
    left.owner === right.owner && left.repo === right.repo && left.remoteUrl === right.remoteUrl
  );
}

export function* isWorkItemRepositoryQuestionSteps(
  q: Q,
  itemId: string,
  questionId: string,
): Steps<boolean> {
  const asked = q.t.workItemRepositoryQuestion;
  const row = yield* q.one(
    q.orm
      .select({ id: asked.questionId })
      .from(asked)
      .where(and(eq(asked.itemId, itemId), eq(asked.questionId, questionId))),
  );
  return row !== undefined;
}

export function isWorkItemRepositoryQuestion(
  db: Database,
  itemId: string,
  questionId: string,
): boolean {
  return settled(sqliteDb(db).run((q) => isWorkItemRepositoryQuestionSteps(q, itemId, questionId)));
}
