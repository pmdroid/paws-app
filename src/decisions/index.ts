import {
  acceptDecisionSuggestionSteps,
  answeredDecisionQuestionSteps,
  auditWorkspaceAccessSteps,
  correctDecisionMemorySteps,
  decisionRowSteps,
  decisionScopeSteps,
  getLinearSessionAccessSteps,
  insertDecisionMemorySteps,
  itemPathHintsSteps,
  listDecisionRowsSteps,
  openDecisionSuggestionSteps,
  recordDecisionSuggestionSteps,
  replaceDecisionSearchSteps,
  retireDecisionMemorySteps,
  searchDecisionRowsSteps,
  settled,
  sqliteDb,
  unsavedDecisionAnswersSteps,
  workspaceLinearMemberSteps,
  workspaceMemberSteps,
  workspaceMemberUsable,
  workspaceSessionIdsSteps,
  type DecisionRow as Row,
  type DecisionScope as Scope,
  type Q,
  type Steps,
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
function* accessibleSteps(q: Q, actor: Actor, source: Scope | null) {
  return (
    source !== null &&
    source.workspaceId === actor.workspaceId &&
    source.clientId === actor.clientId &&
    (yield* workspaceSessionIdsSteps(q, actor.workspaceId, actor.userId, actor.clientId)).includes(
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
export async function listDecisions(db: Database, actor: Actor, search = ""): Promise<Decision[]> {
  const query = terms(search);
  return sqliteDb(db).run(function* (q) {
    const rows = search.trim()
      ? query
        ? yield* searchDecisionRowsSteps(q, { workspaceId: actor.workspaceId, query, limit: 200 })
        : []
      : yield* listDecisionRowsSteps(q, actor.workspaceId);
    const decisions: Decision[] = [];
    for (const row of rows) {
      const source = yield* decisionScopeSteps(q, row.questionId);
      if (yield* accessibleSteps(q, actor, source)) decisions.push(mapped(row, source!));
    }
    return decisions;
  });
}
export async function decisionAnswers(db: Database, actor: Actor) {
  return sqliteDb(db).run(function* (q) {
    const sessions = yield* workspaceSessionIdsSteps(
      q,
      actor.workspaceId,
      actor.userId,
      actor.clientId,
    );
    const answers = [];
    for (const row of yield* unsavedDecisionAnswersSteps(q)) {
      if (!sessions.includes(row.sessionId)) continue;
      const source = yield* decisionScopeSteps(q, row.id);
      if (yield* accessibleSteps(q, actor, source))
        answers.push({ ...row, repository: source!.repository });
    }
    return answers.slice(0, 100);
  });
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
export async function changeDecision(
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
): Promise<string> {
  return sqliteDb(db).transaction(function* (q) {
    const member = yield* workspaceMemberSteps(q, actor.workspaceId, actor.userId);
    if (!workspaceMemberUsable(member))
      throw new Error("Current workspace membership is required.");
    const previous = input.id ? yield* decisionRowSteps(q, input.id) : null;
    const questionId = previous?.questionId ?? input.questionId ?? "";
    if (
      (input.id && !previous) ||
      !(yield* accessibleSteps(q, actor, yield* decisionScopeSteps(q, questionId)))
    )
      throw new Error("This answer is not accessible.");
    if (
      previous &&
      (previous.workspaceId !== actor.workspaceId ||
        previous.revision !== input.revision ||
        previous.retiredAt !== null)
    )
      throw new Error("This decision changed. Refresh before editing.");
    const question = yield* answeredDecisionQuestionSteps(q, questionId);
    if (
      !question?.answer ||
      !question.answeredBy ||
      ["unknown", "linear"].includes(question.answeredBy)
    )
      throw new Error("Save a confirmed human answer.");
    const id = previous?.id ?? randomUUID();
    if (input.retire) {
      if (!previous) throw new Error("Choose an existing decision.");
      yield* retireDecisionMemorySteps(q, { id, userId: actor.userId, now });
    } else {
      const value = settings(input);
      const change = { ...value, id, userId: actor.userId, now };
      if (previous) yield* correctDecisionMemorySteps(q, change);
      else
        yield* insertDecisionMemorySteps(q, {
          ...change,
          workspaceId: actor.workspaceId,
          questionId,
        });
      yield* replaceDecisionSearchSteps(q, { id, statement: value.statement, tags: value.tags });
    }
    yield* auditWorkspaceAccessSteps(q, {
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
  });
}
export function suggestDecisions(db: Database, questionId: string, text: string) {
  return settled(sqliteDb(db).run((q) => suggestDecisionsSteps(q, questionId, text)));
}
export function* suggestDecisionsSteps(q: Q, questionId: string, text: string) {
  const target = yield* decisionScopeSteps(q, questionId);
  const query = terms(text);
  if (!target || !query || (yield* getLinearSessionAccessSteps(q, target.sessionId)) !== "allowed")
    return [];
  const context = yield* itemPathHintsSteps(q, target.itemId);
  const paths: string[] = context?.paths
    ? JSON.parse(context.paths)
    : hintedPaths(context?.brief ?? null);
  const candidates = yield* searchDecisionRowsSteps(q, {
    workspaceId: target.workspaceId,
    query,
    limit: 30,
    activeOnly: true,
  });
  const decisions: Decision[] = [];
  for (const row of candidates) {
    if (decisions.length === 3) break;
    const source = yield* decisionScopeSteps(q, row.questionId);
    if (
      !source ||
      source.teamId !== target.teamId ||
      source.clientId !== target.clientId ||
      source.repository !== target.repository ||
      (yield* getLinearSessionAccessSteps(q, source.sessionId)) !== "allowed"
    )
      continue;
    const decision = mapped(row, source);
    if (
      decision.scopeGlobs.includes("**") ||
      decision.scopeGlobs.includes("**/*") ||
      paths.some(
        (path) =>
          path !== "*" && decision.scopeGlobs.some((glob) => new Bun.Glob(glob).match(path)),
      )
    )
      decisions.push(decision);
  }
  const suggestions = [];
  for (const decision of decisions) {
    const suggestionId = yield* recordDecisionSuggestionSteps(q, {
      id: randomUUID(),
      questionId,
      decisionId: decision.id,
      revision: decision.revision,
      statement: decision.statement,
    });
    suggestions.push({ ...decision, value: `/paws decision ${suggestionId}` });
  }
  return suggestions;
}
export function confirmDecision(
  db: Database,
  questionId: string,
  command: string,
  linearUserId: string,
  now: number,
): string | null {
  return settled(
    sqliteDb(db).transaction((q) =>
      confirmDecisionSteps(q, questionId, command, linearUserId, now),
    ),
  );
}
export function* confirmDecisionSteps(
  q: Q,
  questionId: string,
  command: string,
  linearUserId: string,
  now: number,
): Steps<string | null> {
  const match = /^\/paws decision ([a-f0-9-]{36})$/.exec(command);
  if (!match) return null;
  const target = yield* decisionScopeSteps(q, questionId);
  if (!target) throw new Error("This question is no longer accessible.");
  const member = yield* workspaceLinearMemberSteps(q, target.workspaceId, linearUserId);
  const actor = {
    workspaceId: target.workspaceId,
    userId: member?.userId ?? "",
    clientId: target.clientId,
  };
  const saved = yield* openDecisionSuggestionSteps(q, match[1]!, questionId);
  const decision = saved
    ? yield* decisionRowSteps(q, saved.decisionId, { activeOnly: true })
    : null;
  const source = decision ? yield* decisionScopeSteps(q, decision.questionId) : null;
  if (
    !workspaceMemberUsable(member) ||
    !saved ||
    !decision ||
    saved.revision !== decision.revision ||
    !(yield* accessibleSteps(q, actor, target)) ||
    !source ||
    !(yield* accessibleSteps(q, actor, source)) ||
    source.repository !== target.repository ||
    source.teamId !== target.teamId
  )
    throw new Error(
      "This suggestion changed or is no longer accessible. Answer the question in your own words.",
    );
  yield* acceptDecisionSuggestionSteps(q, match[1]!, linearUserId, now);
  return saved.statement;
}
