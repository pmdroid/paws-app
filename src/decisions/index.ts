import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { hintedPaths } from "../scheduler";
import {
  auditWorkspaceAccess,
  getLinearSessionAccess,
  workspaceLinearMember,
  workspaceMember,
  workspaceSessionIds,
} from "../db";

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
type Scope = {
  workspaceId: string;
  sessionId: string;
  clientId: string;
  teamId: string;
  repository: string;
  identifier: string;
  itemId: string;
};
type Actor = { workspaceId: string; userId: string; clientId: string };
type Row = Omit<Decision, "scopeGlobs" | "tags" | "sourceUrl" | "repository"> & {
  workspaceId: string;
  scopeGlobs: string;
  tags: string;
};
const SELECT = `SELECT d.id,d.workspace_id AS workspaceId,d.question_id AS questionId,d.statement,
 d.scope_globs AS scopeGlobs,d.tags,d.revision,d.retired_at AS retiredAt,q.answered_by AS author,
 (SELECT count(*) FROM decision_suggestion s WHERE s.decision_id=d.id) AS shown,
 (SELECT count(*) FROM decision_suggestion s WHERE s.decision_id=d.id AND s.accepted_at IS NOT NULL) AS accepted
 FROM decision_memory d JOIN question q ON q.id=d.question_id`;

function scope(db: Database, questionId: string): Scope | null {
  return db
    .query<Scope, [string]>(`SELECT w.id AS workspaceId,s.session_id AS sessionId,
    s.oauth_client_id AS clientId,s.team_id AS teamId,lower(r.owner || '/' || r.repo) AS repository,
    i.linear_identifier AS identifier,i.id AS itemId FROM question q JOIN work_item i ON i.id=q.item_id
    JOIN linear_session s ON s.session_id=q.session_id
    JOIN workspace w ON w.linear_organization_id=s.organization_id
    JOIN work_item_repository r ON r.item_id=i.id
    JOIN workspace_repository p ON p.workspace_id=w.id AND p.team_id=s.team_id
      AND p.repository=lower(r.owner || '/' || r.repo)
    WHERE q.id=? AND s.installation_observed_at IS NOT NULL`)
    .get(questionId);
}
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
    : db
        .query<Row, [string]>(`${SELECT}
    WHERE d.workspace_id=? ORDER BY d.updated_at DESC LIMIT 200`)
        .all(actor.workspaceId);
  return rows.flatMap((row) => {
    const source = scope(db, row.questionId);
    return accessible(db, actor, source) ? [mapped(row, source)] : [];
  });
}
export function decisionAnswers(db: Database, actor: Actor) {
  const sessions = workspaceSessionIds(db, actor.workspaceId, actor.userId, actor.clientId);
  return db
    .query<{ id: string; body: string; answer: string; author: string; sessionId: string }, []>(
      `SELECT q.id,q.body,q.answer,q.answered_by AS author,q.session_id AS sessionId FROM question q
    WHERE q.status='answered' AND q.cancelled_at IS NULL AND q.answer IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM decision_memory d WHERE d.question_id=q.id)
    ORDER BY q.answered_at DESC`,
    )
    .all()
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
      if (!member?.active || member.role === "observer")
        throw new Error("Current workspace membership is required.");
      const previous = input.id
        ? db.query<Row, [string]>(`${SELECT} WHERE d.id=?`).get(input.id)
        : null;
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
      const question = db
        .query<{ answer: string | null; answered_by: string | null }, [string]>(
          "SELECT answer,answered_by FROM question WHERE id=? AND status='answered' AND cancelled_at IS NULL",
        )
        .get(questionId);
      if (
        !question?.answer ||
        !question.answered_by ||
        ["unknown", "linear"].includes(question.answered_by)
      )
        throw new Error("Save a confirmed human answer.");
      const id = previous?.id ?? randomUUID();
      if (input.retire) {
        if (!previous) throw new Error("Choose an existing decision.");
        db.run(
          "UPDATE decision_memory SET retired_at=?,revision=revision+1,updated_by=?,updated_at=? WHERE id=?",
          [now, actor.userId, now, id],
        );
      } else {
        const value = settings(input);
        if (previous)
          db.run(
            "UPDATE decision_memory SET statement=?,scope_globs=?,tags=?,revision=revision+1,updated_by=?,updated_at=? WHERE id=?",
            [value.statement, value.globs, value.tags, actor.userId, now, id],
          );
        else
          db.run(
            "INSERT INTO decision_memory(id,workspace_id,question_id,statement,scope_globs,tags,saved_by,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
            [
              id,
              actor.workspaceId,
              questionId,
              value.statement,
              value.globs,
              value.tags,
              actor.userId,
              actor.userId,
              now,
            ],
          );
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
  const context = db
    .query<{ paths: string | null; brief: string | null }, [string]>(
      "SELECT s.paths,i.brief FROM work_item i LEFT JOIN work_item_scheduling s ON s.item_id=i.id WHERE i.id=?",
    )
    .get(target.itemId);
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
      db.run(
        "INSERT OR IGNORE INTO decision_suggestion(id,question_id,decision_id,revision,statement) VALUES(?,?,?,?,?)",
        [randomUUID(), questionId, decision.id, decision.revision, decision.statement],
      );
      const saved = db
        .query<{ id: string }, [string, string]>(
          "SELECT id FROM decision_suggestion WHERE question_id=? AND decision_id=?",
        )
        .get(questionId, decision.id)!;
      return { ...decision, value: `/paws decision ${saved.id}` };
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
  const target = scope(db, questionId);
  if (!target) throw new Error("This question is no longer accessible.");
  const member = workspaceLinearMember(db, target.workspaceId, linearUserId);
  const actor = {
    workspaceId: target.workspaceId,
    userId: member?.userId ?? "",
    clientId: target.clientId,
  };
  const saved = db
    .query<{ decisionId: string; revision: number; statement: string }, [string, string]>(
      "SELECT decision_id AS decisionId,revision,statement FROM decision_suggestion WHERE id=? AND question_id=? AND accepted_at IS NULL",
    )
    .get(match[1]!, questionId);
  const decision = saved
    ? db
        .query<Row, [string]>(`${SELECT} WHERE d.id=? AND d.retired_at IS NULL`)
        .get(saved.decisionId)
    : null;
  const source = decision ? scope(db, decision.questionId) : null;
  if (
    !member?.active ||
    member.role === "observer" ||
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
  db.run("UPDATE decision_suggestion SET accepted_by=?,accepted_at=? WHERE id=?", [
    linearUserId,
    now,
    match[1]!,
  ]);
  return saved.statement;
}
