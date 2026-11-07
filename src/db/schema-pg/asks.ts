import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspace, workspaceUser } from "./workspace";
import { workItem } from "./items";

export const decisionMemory = pgTable(
  "decision_memory",
  {
    id: text().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    questionId: text("question_id")
      .notNull()
      .references(() => question.id),
    statement: text().notNull(),
    scopeGlobs: jsonb("scope_globs").notNull(),
    tags: jsonb().notNull(),
    revision: bigint({ mode: "number" }).default(1).notNull(),
    retiredAt: bigint("retired_at", { mode: "number" }),
    savedBy: text("saved_by")
      .notNull()
      .references(() => workspaceUser.id),
    updatedBy: text("updated_by")
      .notNull()
      .references(() => workspaceUser.id),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [unique().on(table.questionId)],
);

export const decisionSuggestion = pgTable(
  "decision_suggestion",
  {
    id: text().primaryKey(),
    questionId: text("question_id")
      .notNull()
      .references(() => question.id),
    decisionId: text("decision_id")
      .notNull()
      .references(() => decisionMemory.id),
    revision: bigint({ mode: "number" }).notNull(),
    statement: text().notNull(),
    acceptedBy: text("accepted_by"),
    acceptedAt: bigint("accepted_at", { mode: "number" }),
  },
  (table) => [
    unique().on(table.questionId, table.decisionId),
    uniqueIndex("decision_suggestion_answer")
      .on(table.questionId)
      .where(sql`accepted_at IS NOT NULL`),
  ],
);

export const question = pgTable(
  "question",
  {
    id: text().primaryKey(),
    itemId: text("item_id").notNull(),
    runId: text("run_id"),
    sessionId: text("session_id").notNull(),
    kind: text().default("agent").notNull(),
    body: text().notNull(),
    context: text(),
    options: jsonb(),
    status: text().notNull(),
    answer: text(),
    answeredBy: text("answered_by"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    answeredAt: bigint("answered_at", { mode: "number" }),
    cancelledAt: bigint("cancelled_at", { mode: "number" }),
    answerEventKey: text("answer_event_key"),
    reason: text(),
    handoffVersion: bigint("handoff_version", { mode: "number" }),
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
    check("question_check_2", sql`status IN ('queued', 'open', 'answered')`),
  ],
);

export const planProposal = pgTable(
  "plan_proposal",
  {
    questionId: text("question_id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    parentIssueId: text("parent_issue_id").notNull(),
    repository: text(),
    drafts: jsonb().notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    filed: jsonb(),
    filedAt: bigint("filed_at", { mode: "number" }),
  },
  (table) => [index("plan_proposal_item").on(table.itemId)],
);

export const linkAsk = pgTable(
  "link_ask",
  {
    questionId: text("question_id")
      .primaryKey()
      .references(() => question.id),
    itemId: text("item_id").notNull(),
    kind: text().notNull(),
    headCommit: text("head_commit").notNull(),
    link: text().notNull(),
    title: text().notNull(),
    detail: text().notNull(),
    answerers: jsonb().notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    decision: text(),
    note: text(),
    decidedBy: text("decided_by"),
    decidedAt: bigint("decided_at", { mode: "number" }),
    closedReason: text("closed_reason"),
    closedAt: bigint("closed_at", { mode: "number" }),
    rounds: jsonb(),
  },
  (table) => [
    index("link_ask_item_open").on(table.itemId, table.closedAt),
    check(
      "link_ask_check_1",
      sql`kind IN ('bypass', 'screenshots', 'risk', 'question', 'rounds', 'rule')`,
    ),
    check(
      "link_ask_check_3",
      sql`decision IN ('approve', 'changes', 'answer', 'rethink', 'continue', 'stop')`,
    ),
    check(
      "link_ask_check_4",
      sql`closed_reason IN ('decided', 'guidance', 'head_moved', 'cancelled')`,
    ),
  ],
);
