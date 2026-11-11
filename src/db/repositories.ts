import type { Database } from "bun:sqlite";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { RepositoryBinding } from "../core";
import { settled, sqliteDb, type Q, type Steps, type Db } from "./db";
import { jsonValue } from "./json-text";

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

export async function getWorkItemRepository(
  store: Db,
  itemId: string,
): Promise<RepositoryBinding | null> {
  return store.run((q) => getWorkItemRepositorySteps(q, itemId));
}

export function bindWorkItemRepository(
  store: Db,
  itemId: string,
  repository: RepositoryBinding,
): Promise<RepositoryBinding> {
  return store.transaction((q) => bindWorkItemRepositorySteps(q, itemId, repository));
}

export function* bindWorkItemRepositorySteps(
  q: Q,
  itemId: string,
  repository: RepositoryBinding,
): Steps<RepositoryBinding> {
  if (
    !/^[a-z0-9_.-]+$/i.test(repository.owner) ||
    !/^[a-z0-9_.-]+$/i.test(repository.repo) ||
    [repository.owner, repository.repo].some((value) => value === "." || value === "..") ||
    repository.remoteUrl.trim().length === 0
  ) {
    throw new Error("A work item repository requires an owner, repository name and remote URL");
  }
  yield* q.exec(
    q.orm
      .insert(q.t.workItemRepository)
      .values({
        itemId,
        owner: repository.owner,
        repo: repository.repo,
        remoteUrl: repository.remoteUrl,
      })
      .onConflictDoNothing(),
  );
  const saved = yield* getWorkItemRepositorySteps(q, itemId);
  if (
    saved === null ||
    saved.owner !== repository.owner ||
    saved.repo !== repository.repo ||
    saved.remoteUrl !== repository.remoteUrl
  ) {
    throw new Error("A work item's repository cannot change after it has been bound");
  }
  return saved;
}

export function* saveWorkItemRepositoryQuestionSteps(
  q: Q,
  itemId: string,
  questionId: string,
  candidates: readonly RepositoryBinding[],
) {
  const { workItemRepositoryQuestion: w } = q.t;
  yield* q.exec(
    q.orm
      .insert(w)
      .values({ itemId, questionId, candidates: jsonValue(q, candidates) })
      .onConflictDoUpdate({
        target: w.itemId,
        set: {
          questionId: sql`excluded.question_id`,
          candidates: sql`excluded.candidates`,
          chosenRepository: null,
        },
      }),
  );
}

export async function saveWorkItemRepositoryQuestion(
  store: Db,
  itemId: string,
  questionId: string,
  candidates: readonly RepositoryBinding[],
): Promise<void> {
  await store.run((q) => saveWorkItemRepositoryQuestionSteps(q, itemId, questionId, candidates));
}

export async function getWorkItemRepositoryAnswer(
  store: Db,
  itemId: string,
): Promise<{
  questionId: string;
  answer: string;
  candidates: readonly RepositoryBinding[];
} | null> {
  return store.run((q) => getWorkItemRepositoryAnswerSteps(q, itemId));
}

export function* getWorkItemRepositoryAnswerSteps(
  q: Q,
  itemId: string,
): Steps<{ questionId: string; answer: string; candidates: readonly RepositoryBinding[] } | null> {
  const { question: questions, workItemRepositoryQuestion: asked } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ questionId: questions.id, answer: questions.answer, candidates: asked.candidates })
      .from(asked)
      .innerJoin(questions, eq(questions.id, asked.questionId))
      .where(
        and(
          eq(asked.itemId, itemId),
          eq(questions.status, "answered"),
          isNotNull(questions.answer),
        ),
      ),
  );
  return row === undefined
    ? null
    : {
        questionId: row.questionId,
        answer: row.answer!,
        candidates: (q.dialect === "sqlite"
          ? JSON.parse(row.candidates as string)
          : row.candidates) as readonly RepositoryBinding[],
      };
}

export function* rememberWorkItemRepositoryChoiceSteps(
  q: Q,
  itemId: string,
  questionId: string,
  repository: RepositoryBinding,
): Steps<boolean> {
  const answer = yield* getWorkItemRepositoryAnswerSteps(q, itemId);
  if (answer === null || answer.questionId !== questionId) return false;
  if (!answer.candidates.some((candidate) => sameRepository(candidate, repository)))
    throw new Error("The chosen repository was not offered for this question");
  const asked = q.t.workItemRepositoryQuestion;
  yield* q.exec(
    q.orm
      .update(asked)
      .set({ chosenRepository: q.dialect === "sqlite" ? JSON.stringify(repository) : repository })
      .where(and(eq(asked.itemId, itemId), eq(asked.questionId, questionId))),
  );
  return true;
}

export async function rememberWorkItemRepositoryChoice(
  store: Db,
  itemId: string,
  questionId: string,
  repository: RepositoryBinding,
): Promise<boolean> {
  return store.transaction((q) =>
    rememberWorkItemRepositoryChoiceSteps(q, itemId, questionId, repository),
  );
}

export function* getWorkItemRepositoryChoiceSteps(
  q: Q,
  itemId: string,
): Steps<RepositoryBinding | null> {
  const { question: questions, workItemRepositoryQuestion: asked } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ chosen: asked.chosenRepository })
      .from(asked)
      .innerJoin(questions, eq(questions.id, asked.questionId))
      .where(
        and(
          eq(asked.itemId, itemId),
          eq(questions.status, "answered"),
          isNotNull(asked.chosenRepository),
        ),
      ),
  );
  if (row === undefined) return null;
  return (
    q.dialect === "sqlite" ? JSON.parse(row.chosen as string) : row.chosen
  ) as RepositoryBinding;
}

export async function getWorkItemRepositoryChoice(
  store: Db,
  itemId: string,
): Promise<RepositoryBinding | null> {
  return store.run((q) => getWorkItemRepositoryChoiceSteps(q, itemId));
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

export async function isWorkItemRepositoryQuestion(
  store: Db,
  itemId: string,
  questionId: string,
): Promise<boolean> {
  return store.run((q) => isWorkItemRepositoryQuestionSteps(q, itemId, questionId));
}
