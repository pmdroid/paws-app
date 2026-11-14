import { journalCaught } from "../journal";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { type Q, type Db } from "./db";
import { jsonText } from "./json-text";

export type OpenQuestionRecord = {
  id: string;
  itemId: string;
  runId: string | null;
  sessionId: string;
  body: string;
  options: string[];
  createdAt: number;
};

export type WorkItemFact = {
  itemId: string;
  owner: string | null;
  ownerId: string | null;
  projectId: string | null;
  projectName: string | null;
  createdAt: number;
};

export function* listWorkItemFactsSteps(q: Q) {
  const { workItem, workspaceUser } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        itemId: workItem.id,
        owner: workspaceUser.name,
        ownerId: workItem.ownerUserId,
        projectId: workItem.linearProjectId,
        projectName: workItem.linearProjectName,
        createdAt: workItem.createdAt,
      })
      .from(workItem)
      .leftJoin(workspaceUser, eq(workspaceUser.id, workItem.ownerUserId))
      .orderBy(desc(workItem.createdAt), desc(workItem.id)),
  );
  return rows.map((row): WorkItemFact => ({
    ...row,
    projectName: typeof row.projectName === "string" ? row.projectName : null,
  }));
}

export async function listWorkItemFacts(store: Db): Promise<WorkItemFact[]> {
  return store.run((q) => listWorkItemFactsSteps(q));
}

export function* listOpenQuestionsSteps(q: Q) {
  const { question } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        id: question.id,
        itemId: question.itemId,
        runId: question.runId,
        sessionId: question.sessionId,
        body: question.body,
        options: jsonText(q, question.options),
        createdAt: question.createdAt,
      })
      .from(question)
      .where(and(eq(question.status, "open"), isNull(question.cancelledAt)))
      .orderBy(asc(question.createdAt), asc(question.id)),
  );
  return rows.map((row): OpenQuestionRecord => ({
    ...row,
    options: row.options === null ? [] : stringList(row.options),
  }));
}

/** Unanswered questions, oldest first. */
export async function listOpenQuestions(store: Db): Promise<OpenQuestionRecord[]> {
  return store.run((q) => listOpenQuestionsSteps(q));
}

export type DeliveredLinearIssueState = {
  stateType: string | null;
  identifier: string | null;
};

/** The text at `path` of the payload: `json_extract` on SQLite, `#>>` on Postgres. */
function payloadText(q: Q, path: string[]) {
  const { payload } = q.t.inboxEvent;
  return q.dialect === "postgres"
    ? sql<string | null>`(${payload} #>> ${sql.raw(`'{${path.join(",")}}'`)})`
    : sql<string | null>`json_extract(${payload}, ${sql.raw(`'$.${path.join(".")}'`)})`;
}

export function* deliveredLinearIssueStateSteps(q: Q, organizationId: string, issueId: string) {
  const { inboxEvent } = q.t;
  const at = (...path: string[]) => payloadText(q, path);
  const row = yield* q.one(
    q.orm
      .select({ stateType: at("data", "state", "type"), identifier: at("data", "identifier") })
      .from(inboxEvent)
      .where(
        and(
          eq(at("type"), "Issue"),
          eq(at("data", "id"), issueId),
          eq(at("organizationId"), organizationId),
        ),
      )
      .orderBy(desc(inboxEvent.updatedAtMs), desc(inboxEvent.receivedAt))
      .limit(1),
  );
  return (row ?? null) satisfies DeliveredLinearIssueState | null;
}

export async function deliveredLinearIssueState(
  store: Db,
  organizationId: string,
  issueId: string,
): Promise<DeliveredLinearIssueState | null> {
  return store.run((q) => deliveredLinearIssueStateSteps(q, organizationId, issueId));
}

function stringList(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (typeof item !== "object" || item === null) return [];
      const label = item.label ?? item.value;
      return typeof label === "string" ? [label] : [];
    });
  } catch (caughtError1) {
    journalCaught(caughtError1, "reads.stringList.parse", null);
    return [];
  }
}

export function* openQuestionKindSteps(q: Q, id: string) {
  const { question } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ kind: question.kind })
      .from(question)
      .where(and(eq(question.id, id), eq(question.status, "open"), isNull(question.cancelledAt))),
  );
  return row?.kind ?? null;
}

export async function openQuestionKind(store: Db, id: string): Promise<string | null> {
  return store.run((q) => openQuestionKindSteps(q, id));
}
