import {
  acceptDecisionSuggestion,
  answeredDecisionQuestion,
  auditWorkspaceAccess,
  correctDecisionMemory,
  decisionRow,
  decisionScope as scope,
  getLinearSessionAccess,
  insertDecisionMemory,
  itemPathHints,
  listDecisionRows,
  openDecisionSuggestion,
  recordDecisionSuggestion,
  retireDecisionMemory,
  unsavedDecisionAnswers,
  workspaceLinearMember,
  workspaceMember,
  workspaceMemberUsable,
  workspaceSessionIds,
  type DecisionRow as Row,
  type DecisionScope as Scope,
} from "../db";
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { hintedPaths } from "../scheduler";

export type Decision = {
  id: string;
  questionId: string;
  statement: string;
  scopeGlobs: string[];
  tags: string[];
  revision: number;
  retiredAt: number | null;
  author: string;
  sourceUrl: string;
  repository: string;
  shown: number;
  accepted: number;
};
type Actor = { workspaceId: string; userId: string; clientId: string };
const SELECT = `SELECT d.id,d.workspace_id AS workspaceId,d.question_id AS questionId,d.statement,
 d.scope_globs AS scopeGlobs,d.tags,d.revision,d.retired_at AS retiredAt,q.answered_by AS author,
 (SELECT count(*) FROM decision_suggestion s WHERE s.decision_id=d.id) AS shown,
 (SELECT count(*) FROM decision_suggestion s WHERE s.decision_id=d.id AND s.accepted_at IS NOT NULL) AS accepted
 FROM decision_memory d JOIN question q ON q.id=d.question_id`;

function accessible(db: Database, actor: Actor, source: Scope | null): source is Scope {
  return (
    source !== null &&
    source.workspaceId === actor.workspaceId &&
    source.clientId === actor.clientId &&
    workspaceSessionIds(db, actor.workspaceId, actor.userId, actor.clientId).includes(
      source.sessionId,
    )
  );
}
function mapped(row: Row, source: Scope): Decision {
  return {
    id: row.id,
    questionId: row.questionId,
    statement: row.statement,
    scopeGlobs: JSON.parse(row.scopeGlobs),
    tags: JSON.parse(row.tags),
    revision: row.revision,
    retiredAt: row.retiredAt,
    author: row.author,
    repository: source.repository,
    sourceUrl: `https://linear.app/issue/${encodeURIComponent(source.identifier)}`,
    shown: row.shown,
    accepted: row.accepted,
  };
}
function terms(text: string): string | null {
  const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? [])].slice(0, 24);
  return words.length ? words.map((word) => `"${word}"`).join(" OR ") : null;
}
export function listDecisions(db: Database, actor: Actor, search = ""): Decision[] {
  const query = terms(search);
  const rows = search.trim()
    ? query
      ? db
          .query<Row, [string, string]>(`${SELECT}
    JOIN decision_memory_search f ON f.decision_id=d.id
    WHERE d.workspace_id=? AND decision_memory_search MATCH ? ORDER BY bm25(decision_memory_search) LIMIT 200`)
          .all(actor.workspaceId, query)
      : []
    : listDecisionRows(db, actor.workspaceId);
  return rows.flatMap((row) => {
    const source = scope(db, row.questionId);
    return accessible(db, actor, source) ? [mapped(row, source)] : [];
  });
}
export function decisionAnswers(db: Database, actor: Actor) {
  const sessions = workspaceSessionIds(db, actor.workspaceId, actor.userId, actor.clientId);
  return unsavedDecisionAnswers(db)
    .flatMap((row) => {
      if (!sessions.includes(row.sessionId)) return [];
      const source = scope(db, row.id);
      return accessible(db, actor, source) ? [{ ...row, repository: source.repository }] : [];
    })
    .slice(0, 100);
}
function settings(input: { statement?: unknown; scopeGlobs?: unknown; tags?: unknown }) {
  if (
    typeof input.statement !== "string" ||
    !input.statement.trim() ||
    input.statement.length > 4000 ||
    !Array.isArray(input.scopeGlobs) ||
    input.scopeGlobs.length < 1 ||
    input.scopeGlobs.length > 20 ||
    !input.scopeGlobs.every(
      (v) =>
        typeof v === "string" &&
        v.length > 0 &&
        v.length <= 200 &&
        !v.startsWith("/") &&
        !v.split("/").includes(".."),
    ) ||
    !Array.isArray(input.tags) ||
    input.tags.length > 20 ||
    !input.tags.every((v) => typeof v === "string" && v.length > 0 && v.length <= 60)
  )
    throw new Error("Enter a decision, relative path globs, and up to 20 tags.");
  for (const glob of input.scopeGlobs) new Bun.Glob(glob).match("src/example.ts");
  return {
    statement: input.statement.trim(),
    globs: JSON.stringify(input.scopeGlobs),
    tags: JSON.stringify(input.tags),
  };
}
export function changeDecision(
  db: Database,
  actor: Actor,
  input: {
    questionId?: string;
    id?: string;
    revision?: number;
    retire?: boolean;
    statement?: unknown;
    scopeGlobs?: unknown;
    tags?: unknown;
  },
  now: number,
) {
  return db
    .transaction(() => {
      const member = workspaceMember(db, actor.workspaceId, actor.userId);
      if (!workspaceMemberUsable(member))
        throw new Error("Current workspace membership is required.");
      const previous = input.id ? decisionRow(db, input.id) : null;
      const questionId = previous?.questionId ?? input.questionId ?? "";
      if ((input.id && !previous) || !accessible(db, actor, scope(db, questionId)))
        throw new Error("This answer is not accessible.");
      if (
        previous &&
        (previous.workspaceId !== actor.workspaceId ||
          previous.revision !== input.revision ||
          previous.retiredAt !== null)
      )
        throw new Error("This decision changed. Refresh before editing.");
      const question = answeredDecisionQuestion(db, questionId);
      if (
        !question?.answer ||
        !question.answeredBy ||
        ["unknown", "linear"].includes(question.answeredBy)
      )
        throw new Error("Save a confirmed human answer.");
      const id = previous?.id ?? randomUUID();
      if (input.retire) {
        if (!previous) throw new Error("Choose an existing decision.");
        retireDecisionMemory(db, { id, userId: actor.userId, now });
      } else {
        const value = settings(input);
        const change = { ...value, id, userId: actor.userId, now };
        if (previous) correctDecisionMemory(db, change);
        else insertDecisionMemory(db, { ...change, workspaceId: actor.workspaceId, questionId });
        db.run("DELETE FROM decision_memory_search WHERE decision_id=?", [id]);
        db.run("INSERT INTO decision_memory_search(decision_id,statement,tags) VALUES(?,?,?)", [
          id,
          value.statement,
          value.tags,
        ]);
      }
      auditWorkspaceAccess(db, {
        workspaceId: actor.workspaceId,
        userId: actor.userId,
        action: input.retire
          ? "decision.retired"
          : previous
            ? "decision.corrected"
            : "decision.saved",
        subject: id,
        now,
      });
      return id;
    })
    .immediate();
}
export function suggestDecisions(db: Database, questionId: string, text: string) {
  const target = scope(db, questionId);
  const query = terms(text);
  if (!target || !query || getLinearSessionAccess(db, target.sessionId) !== "allowed") return [];
  const context = itemPathHints(db, target.itemId);
  const paths: string[] = context?.paths
    ? JSON.parse(context.paths)
    : hintedPaths(context?.brief ?? null);
  const candidates = db
    .query<Row, [string, string]>(`${SELECT} JOIN decision_memory_search f ON f.decision_id=d.id
    WHERE d.workspace_id=? AND d.retired_at IS NULL AND decision_memory_search MATCH ? ORDER BY bm25(decision_memory_search) LIMIT 30`)
    .all(target.workspaceId, query);
  return candidates
    .flatMap((row) => {
      const source = scope(db, row.questionId);
      if (
        !source ||
        source.teamId !== target.teamId ||
        source.clientId !== target.clientId ||
        source.repository !== target.repository ||
        getLinearSessionAccess(db, source.sessionId) !== "allowed"
      )
        return [];
      const decision = mapped(row, source);
      if (
        !decision.scopeGlobs.includes("**") &&
        !decision.scopeGlobs.includes("**/*") &&
        !paths.some(
          (path) =>
            path !== "*" && decision.scopeGlobs.some((glob) => new Bun.Glob(glob).match(path)),
        )
      )
        return [];
      return [decision];
    })
    .slice(0, 3)
    .map((decision) => {
      const suggestionId = recordDecisionSuggestion(db, {
        id: randomUUID(),
        questionId,
        decisionId: decision.id,
        revision: decision.revision,
        statement: decision.statement,
      });
      return { ...decision, value: `/paws decision ${suggestionId}` };
    });
}
export function confirmDecision(
  db: Database,
  questionId: string,
  command: string,
  linearUserId: string,
  now: number,
): string | null {
  const match = /^\/paws decision ([a-f0-9-]{36})$/.exec(command);
  if (!match) return null;
  return db
    .transaction(() => {
      const target = scope(db, questionId);
      if (!target) throw new Error("This question is no longer accessible.");
      const member = workspaceLinearMember(db, target.workspaceId, linearUserId);
      const actor = {
        workspaceId: target.workspaceId,
        userId: member?.userId ?? "",
        clientId: target.clientId,
      };
      const saved = openDecisionSuggestion(db, match[1]!, questionId);
      const decision = saved ? decisionRow(db, saved.decisionId, { activeOnly: true }) : null;
      const source = decision ? scope(db, decision.questionId) : null;
      if (
        !workspaceMemberUsable(member) ||
        !saved ||
        !decision ||
        saved.revision !== decision.revision ||
        !accessible(db, actor, target) ||
        !accessible(db, actor, source) ||
        source.repository !== target.repository ||
        source.teamId !== target.teamId
      )
        throw new Error(
          "This suggestion changed or is no longer accessible. Answer the question in your own words.",
        );
      acceptDecisionSuggestion(db, match[1]!, linearUserId, now);
      return saved.statement;
    })
    .immediate();
}
