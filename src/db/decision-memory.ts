import { and, asc, desc, eq, inArray, isNotNull, isNull, notExists, sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { type Q, type Db } from "./db";
import { jsonFromText, jsonText } from "./json-text";
import type { Orm } from "./orm";
import { sessionRepositoryAllowed } from "./workspace-scope";

export type DecisionScope = {
  workspaceId: string;
  sessionId: string;
  clientId: string;
  teamId: string;
  repository: string;
  identifier: string;
  itemId: string;
};

export type DecisionRow = {
  id: string;
  workspaceId: string;
  questionId: string;
  statement: string;
  scopeGlobs: string;
  tags: string;
  revision: number;
  retiredAt: number | null;
  author: string;
  shown: number;
  accepted: number;
};

export type DecisionAnswer = {
  id: string;
  body: string;
  answer: string;
  author: string;
  sessionId: string;
};

export type DecisionContent = { statement: string; globs: string; tags: string };

export async function decisionScope(store: Db, questionId: string): Promise<DecisionScope | null> {
  return store.run((q) => decisionScopeSteps(q, questionId));
}

export function* decisionScopeSteps(q: Q, questionId: string) {
  const { question, workItem, linearSession, workspace, workItemRepository } = q.t;
  const repository = sql<string>`lower(${workItemRepository.owner} || '/' || ${workItemRepository.repo})`;
  const row = yield* q.one(
    q.orm
      .select({
        workspaceId: workspace.id,
        sessionId: linearSession.sessionId,
        clientId: linearSession.oauthClientId,
        teamId: linearSession.teamId,
        repository,
        identifier: workItem.linearIdentifier,
        itemId: workItem.id,
      })
      .from(question)
      .innerJoin(workItem, eq(workItem.id, question.itemId))
      .innerJoin(linearSession, eq(linearSession.sessionId, question.sessionId))
      .innerJoin(workspace, eq(workspace.linearOrganizationId, linearSession.organizationId))
      .innerJoin(workItemRepository, eq(workItemRepository.itemId, workItem.id))
      .where(
        and(
          eq(question.id, questionId),
          isNotNull(linearSession.installationObservedAt),
          sessionRepositoryAllowed(repository),
        ),
      ),
  );
  return (row as DecisionScope | undefined) ?? null;
}

function decisionRows(q: Q) {
  const { decisionMemory: d, decisionSuggestion: s, question } = q.t;
  const suggestions = sql`SELECT count(*) FROM ${s} WHERE ${s.decisionId} = ${d.id}`;
  return q.orm
    .select({
      id: d.id,
      workspaceId: d.workspaceId,
      questionId: d.questionId,
      statement: d.statement,
      scopeGlobs: jsonText(q, d.scopeGlobs),
      tags: jsonText(q, d.tags),
      revision: d.revision,
      retiredAt: d.retiredAt,
      author: question.answeredBy,
      shown: sql<number>`(${suggestions})`.mapWith(Number),
      accepted: sql<number>`(${suggestions} AND ${s.acceptedAt} IS NOT NULL)`.mapWith(Number),
    })
    .from(d)
    .innerJoin(question, eq(question.id, d.questionId));
}

export async function listDecisionRows(store: Db, workspaceId: string): Promise<DecisionRow[]> {
  return store.run((q) => listDecisionRowsSteps(q, workspaceId));
}

export function* listDecisionRowsSteps(q: Q, workspaceId: string) {
  const { decisionMemory: d } = q.t;
  const rows = yield* q.all(
    decisionRows(q).where(eq(d.workspaceId, workspaceId)).orderBy(desc(d.updatedAt)).limit(200),
  );
  return rows as DecisionRow[];
}

/** SQLite's FTS5 index, created in `raw.ts`. Postgres searches `decision_memory.search` instead. */
const ftsIndex = sqliteTable("decision_memory_search", {
  decisionId: text("decision_id").notNull(),
  statement: text().notNull(),
  tags: text().notNull(),
});

function searchFragment(q: Q, query: string) {
  if (q.dialect === "sqlite")
    return {
      index: sql`${ftsIndex}`,
      match: sql`${ftsIndex} MATCH ${query}`,
      order: [sql`bm25(${ftsIndex})`],
    };
  const { search, id } = q.t.decisionMemory;
  const tsquery = sql`websearch_to_tsquery('simple', ${query})`;
  return {
    index: null,
    match: sql`${search} @@ ${tsquery}`,
    order: [sql`ts_rank(${search}, ${tsquery}) DESC`, asc(id)],
  };
}

type DecisionSearch = {
  workspaceId: string;
  /** FTS5 syntax that `websearch_to_tsquery` also reads: `"word" OR "word"`. */
  query: string;
  limit: number;
  activeOnly?: boolean;
};

export async function searchDecisionRows(
  store: Db,
  search: DecisionSearch,
): Promise<DecisionRow[]> {
  return store.run((q) => searchDecisionRowsSteps(q, search));
}

export function* searchDecisionRowsSteps(q: Q, search: DecisionSearch) {
  const { decisionMemory: d } = q.t;
  const { index, match, order } = searchFragment(q, search.query);
  const rows = decisionRows(q).$dynamic();
  const found = yield* q.all(
    (index ? rows.innerJoin(index, sql`${ftsIndex.decisionId} = ${d.id}`) : rows)
      .where(
        and(
          eq(d.workspaceId, search.workspaceId),
          search.activeOnly ? isNull(d.retiredAt) : undefined,
          match,
        ),
      )
      .orderBy(...order)
      .limit(search.limit),
  );
  return found as DecisionRow[];
}

export async function replaceDecisionSearch(store: Db, entry: DecisionSearchEntry): Promise<void> {
  await store.run((q) => replaceDecisionSearchSteps(q, entry));
}

type DecisionSearchEntry = { id: string; statement: string; tags: string };

/** On Postgres the generated `search` column follows the row, so there is nothing to write. */
export function* replaceDecisionSearchSteps(q: Q, entry: DecisionSearchEntry) {
  if (q.dialect === "postgres") return;
  const orm = q.orm as unknown as Orm;
  yield* q.exec(orm.delete(ftsIndex).where(eq(ftsIndex.decisionId, entry.id)));
  yield* q.exec(
    orm
      .insert(ftsIndex)
      .values({ decisionId: entry.id, statement: entry.statement, tags: entry.tags }),
  );
}

export async function decisionRow(
  store: Db,
  id: string,
  options: { activeOnly?: boolean } = {},
): Promise<DecisionRow | null> {
  return store.run((q) => decisionRowSteps(q, id, options));
}

export function* decisionRowSteps(q: Q, id: string, options: { activeOnly?: boolean } = {}) {
  const { decisionMemory: d } = q.t;
  const row = yield* q.one(
    decisionRows(q).where(and(eq(d.id, id), options.activeOnly ? isNull(d.retiredAt) : undefined)),
  );
  return (row as DecisionRow | undefined) ?? null;
}

export async function unsavedDecisionAnswers(store: Db): Promise<DecisionAnswer[]> {
  return store.run((q) => unsavedDecisionAnswersSteps(q));
}

export function* unsavedDecisionAnswersSteps(q: Q) {
  const { decisionMemory: d, question } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        id: question.id,
        body: question.body,
        answer: question.answer,
        author: question.answeredBy,
        sessionId: question.sessionId,
      })
      .from(question)
      .where(
        and(
          eq(question.status, "answered"),
          isNull(question.cancelledAt),
          isNotNull(question.answer),
          inArray(question.kind, ["agent", "clarification"]),
          notExists(
            q.orm
              .select({ one: sql`1` })
              .from(d)
              .where(eq(d.questionId, question.id)),
          ),
        ),
      )
      .orderBy(sql`${question.answeredAt} DESC NULLS LAST`),
  );
  return rows as DecisionAnswer[];
}

export async function answeredDecisionQuestion(store: Db, questionId: string) {
  return store.run((q) => answeredDecisionQuestionSteps(q, questionId));
}

export function* answeredDecisionQuestionSteps(q: Q, questionId: string) {
  const { question } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ answer: question.answer, answeredBy: question.answeredBy })
      .from(question)
      .where(
        and(
          eq(question.id, questionId),
          eq(question.status, "answered"),
          isNull(question.cancelledAt),
        ),
      ),
  );
  return row ?? null;
}

type DecisionChange = { id: string; userId: string; now: number };

export async function retireDecisionMemory(store: Db, change: DecisionChange): Promise<void> {
  await store.run((q) => retireDecisionMemorySteps(q, change));
}

export function* retireDecisionMemorySteps(q: Q, change: DecisionChange) {
  const { decisionMemory: d } = q.t;
  yield* q.exec(
    q.orm
      .update(d)
      .set({
        retiredAt: change.now,
        revision: sql`${d.revision} + 1`,
        updatedBy: change.userId,
        updatedAt: change.now,
      })
      .where(eq(d.id, change.id)),
  );
}

export async function correctDecisionMemory(
  store: Db,
  change: DecisionChange & DecisionContent,
): Promise<void> {
  await store.run((q) => correctDecisionMemorySteps(q, change));
}

export function* correctDecisionMemorySteps(q: Q, change: DecisionChange & DecisionContent) {
  const { decisionMemory: d } = q.t;
  yield* q.exec(
    q.orm
      .update(d)
      .set({
        statement: change.statement,
        scopeGlobs: jsonFromText(q, change.globs),
        tags: jsonFromText(q, change.tags),
        revision: sql`${d.revision} + 1`,
        updatedBy: change.userId,
        updatedAt: change.now,
      })
      .where(eq(d.id, change.id)),
  );
}

type NewDecision = DecisionChange & DecisionContent & { workspaceId: string; questionId: string };

export async function insertDecisionMemory(store: Db, decision: NewDecision): Promise<void> {
  await store.run((q) => insertDecisionMemorySteps(q, decision));
}

export function* insertDecisionMemorySteps(q: Q, decision: NewDecision) {
  yield* q.exec(
    q.orm.insert(q.t.decisionMemory).values({
      id: decision.id,
      workspaceId: decision.workspaceId,
      questionId: decision.questionId,
      statement: decision.statement,
      scopeGlobs: jsonFromText(q, decision.globs),
      tags: jsonFromText(q, decision.tags),
      savedBy: decision.userId,
      updatedBy: decision.userId,
      updatedAt: decision.now,
    }),
  );
}

type NewSuggestion = {
  id: string;
  questionId: string;
  decisionId: string;
  revision: number;
  statement: string;
};

export async function recordDecisionSuggestion(
  store: Db,
  suggestion: NewSuggestion,
): Promise<string> {
  return store.run((q) => recordDecisionSuggestionSteps(q, suggestion));
}

export function* recordDecisionSuggestionSteps(q: Q, suggestion: NewSuggestion) {
  const { decisionSuggestion: s } = q.t;
  yield* q.exec(q.orm.insert(s).values(suggestion).onConflictDoNothing());
  const saved = yield* q.one(
    q.orm
      .select({ id: s.id })
      .from(s)
      .where(and(eq(s.questionId, suggestion.questionId), eq(s.decisionId, suggestion.decisionId))),
  );
  return saved!.id;
}

export async function openDecisionSuggestion(store: Db, id: string, questionId: string) {
  return store.run((q) => openDecisionSuggestionSteps(q, id, questionId));
}

export function* openDecisionSuggestionSteps(q: Q, id: string, questionId: string) {
  const { decisionSuggestion: s } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ decisionId: s.decisionId, revision: s.revision, statement: s.statement })
      .from(s)
      .where(and(eq(s.id, id), eq(s.questionId, questionId), isNull(s.acceptedAt))),
  );
  return row ?? null;
}

export async function acceptDecisionSuggestion(
  store: Db,
  id: string,
  acceptedBy: string,
  now: number,
): Promise<void> {
  await store.run((q) => acceptDecisionSuggestionSteps(q, id, acceptedBy, now));
}

export function* acceptDecisionSuggestionSteps(q: Q, id: string, acceptedBy: string, now: number) {
  const { decisionSuggestion: s } = q.t;
  yield* q.exec(q.orm.update(s).set({ acceptedBy, acceptedAt: now }).where(eq(s.id, id)));
}
