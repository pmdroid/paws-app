import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { workItem } from "./items";
import { workspace, workspaceUser } from "./workspace";

export const decisionMemory = sqliteTable(
  "decision_memory",
  {
    id: text().primaryKey().notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    questionId: text("question_id")
      .notNull()
      .references(() => question.id),
    statement: text().notNull(),
    scopeGlobs: text("scope_globs").notNull(),
    tags: text().notNull(),
    revision: integer().default(1).notNull(),
    retiredAt: integer("retired_at"),
    savedBy: text("saved_by")
      .notNull()
      .references(() => workspaceUser.id),
    updatedBy: text("updated_by")
      .notNull()
      .references(() => workspaceUser.id),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    unique().on(table.questionId),
    check("decision_memory_check_1", sql`json_valid(scope_globs)`),
    check("decision_memory_check_2", sql`json_valid(tags)`),
  ],
);

export const decisionSuggestion = sqliteTable(
  "decision_suggestion",
  {
    id: text().primaryKey().notNull(),
    questionId: text("question_id")
      .notNull()
      .references(() => question.id),
    decisionId: text("decision_id")
      .notNull()
      .references(() => decisionMemory.id),
    revision: integer().notNull(),
    statement: text().notNull(),
    acceptedBy: text("accepted_by"),
    acceptedAt: integer("accepted_at"),
  },
  (table) => [
    unique().on(table.questionId, table.decisionId),
    uniqueIndex("decision_suggestion_answer")
      .on(table.questionId)
      .where(sql`accepted_at IS NOT NULL`),
  ],
);

export const question = sqliteTable(
  "question",
  {
    id: text().primaryKey().notNull(),
    itemId: text("item_id").notNull(),
    runId: text("run_id"),
    sessionId: text("session_id").notNull(),
    kind: text().default("agent").notNull(),
    body: text().notNull(),
    context: text(),
    options: text(),
    status: text().notNull(),
    answer: text(),
    answeredBy: text("answered_by"),
    createdAt: integer("created_at").notNull(),
    answeredAt: integer("answered_at"),
    cancelledAt: integer("cancelled_at"),
    answerEventKey: text("answer_event_key"),
    reason: text(),
    handoffVersion: integer("handoff_version"),
  },
  (table) => [
    uniqueIndex("question_answer_event")
      .on(table.sessionId, table.answerEventKey)
      .where(sql`answer_event_key IS NOT NULL`),
    uniqueIndex("question_one_active_session")
      .on(table.sessionId)
      .where(sql`status = 'open' AND cancelled_at IS NULL`),
    index("question_run_kind").on(table.runId, table.kind),
    index("question_session_open").on(table.sessionId, table.status),
    check("question_check_1", sql`options IS NULL OR json_valid(options)`),
    check("question_check_2", sql`status IN ('queued', 'open', 'answered')`),
  ],
);

export const planProposal = sqliteTable(
  "plan_proposal",
  {
    questionId: text("question_id").primaryKey().notNull(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    parentIssueId: text("parent_issue_id").notNull(),
    repository: text(),
    drafts: text().notNull(),
    createdAt: integer("created_at").notNull(),
    filed: text(),
    filedAt: integer("filed_at"),
  },
  (table) => [
    index("plan_proposal_item").on(table.itemId),
    check("plan_proposal_check_1", sql`json_valid(drafts)`),
    check("plan_proposal_check_2", sql`filed IS NULL OR json_valid(filed)`),
  ],
);

export const linkAsk = sqliteTable(
  "link_ask",
  {
    questionId: text("question_id")
      .primaryKey()
      .notNull()
      .references(() => question.id),
    itemId: text("item_id").notNull(),
    kind: text().notNull(),
    headCommit: text("head_commit").notNull(),
    link: text().notNull(),
    title: text().notNull(),
    detail: text().notNull(),
    answerers: text().notNull(),
    createdAt: integer("created_at").notNull(),
    decision: text(),
    note: text(),
    decidedBy: text("decided_by"),
    decidedAt: integer("decided_at"),
    closedReason: text("closed_reason"),
    closedAt: integer("closed_at"),
    rounds: text(),
  },
  (table) => [
    index("link_ask_item_open").on(table.itemId, table.closedAt),
    check(
      "link_ask_check_1",
      sql`kind IN ('bypass', 'screenshots', 'risk', 'question', 'rounds', 'rule')`,
    ),
    check("link_ask_check_2", sql`json_valid(answerers)`),
    check(
      "link_ask_check_3",
      sql`decision IN ('approve', 'changes', 'answer', 'rethink', 'continue', 'stop')`,
    ),
    check(
      "link_ask_check_4",
      sql`closed_reason IN ('decided', 'guidance', 'head_moved', 'cancelled')`,
    ),
    check("link_ask_check_5", sql`rounds IS NULL OR json_valid(rounds)`),
  ],
);
