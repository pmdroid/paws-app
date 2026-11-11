import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { jsonb } from "./types";
import { sql } from "drizzle-orm";
import { workspace } from "./workspace";
import { runner } from "./runners";

export const agentAccount = pgTable(
  "agent_account",
  {
    id: text().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    agent: text().notNull(),
    label: text().notNull(),
    legacy: integer().default(0).notNull(),
    enabled: integer().default(1).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    removedAt: bigint("removed_at", { mode: "number" }),
    concurrency: bigint({ mode: "number" }),
  },
  (table) => [
    unique().on(table.id, table.workspaceId, table.agent),
    uniqueIndex("agent_account_label")
      .on(table.workspaceId, table.agent, sql`lower(label)`)
      .where(sql`removed_at IS NULL`),
    uniqueIndex("agent_account_legacy")
      .on(table.workspaceId, table.agent)
      .where(sql`legacy=1`),
    check("agent_account_check_1", sql`length(id) BETWEEN 1 AND 128`),
    check("agent_account_check_2", sql`agent IN ('claude','codex','grok','opencode')`),
    check("agent_account_check_3", sql`length(label) BETWEEN 1 AND 80`),
    check("agent_account_check_4", sql`legacy IN (0,1)`),
    check("agent_account_check_5", sql`enabled IN (0,1)`),
    check("agent_account_check_6", sql`concurrency IS NULL OR concurrency BETWEEN 1 AND 64`),
  ],
);

export const agentAccountBinding = pgTable(
  "agent_account_binding",
  {
    id: text().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    accountId: text("account_id").notNull(),
    agent: text().notNull(),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    legacy: integer().default(0).notNull(),
    quotaScope: text("quota_scope").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    removedAt: bigint("removed_at", { mode: "number" }),
  },
  (table) => [
    index("agent_binding_account").on(table.accountId),
    uniqueIndex("agent_binding_legacy")
      .on(table.runnerId, table.agent)
      .where(sql`legacy=1`),
    uniqueIndex("agent_binding_runner_account")
      .on(table.runnerId, table.accountId)
      .where(sql`removed_at IS NULL`),
    foreignKey({
      columns: [table.accountId, table.workspaceId, table.agent],
      foreignColumns: [agentAccount.id, agentAccount.workspaceId, agentAccount.agent],
      name: "agent_account_binding_account_id_workspace_id_agent_agent_account_id_workspace_id_agent_fk",
    }),
    check("agent_account_binding_check_1", sql`length(id) BETWEEN 1 AND 128`),
    check("agent_account_binding_check_2", sql`legacy IN (0,1)`),
    check("agent_account_binding_check_3", sql`quota_scope IN ('account','unknown')`),
    check("agent_account_binding_check_4", sql`legacy=0 OR quota_scope='unknown'`),
  ],
);

export const runnerCommandAccount = pgTable(
  "runner_command_account",
  {
    commandId: text("command_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    agent: text().notNull(),
    accountId: text("account_id").notNull(),
    bindingId: text("binding_id")
      .notNull()
      .references(() => agentAccountBinding.id),
    named: integer().notNull(),
    recordedAt: bigint("recorded_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("runner_command_account_binding").on(table.bindingId),
    foreignKey({
      columns: [table.accountId, table.workspaceId, table.agent],
      foreignColumns: [agentAccount.id, agentAccount.workspaceId, agentAccount.agent],
      name: "runner_command_account_account_id_workspace_id_agent_agent_account_id_workspace_id_agent_fk",
    }),
    check("runner_command_account_check_1", sql`named IN (0,1)`),
  ],
);

export const runnerAccountCapability = pgTable(
  "runner_account_capability",
  {
    runnerId: text("runner_id")
      .primaryKey()
      .references(() => runner.id),
    protocol: bigint({ mode: "number" }).notNull(),
    bindings: jsonb().notNull(),
    reportedAt: bigint("reported_at", { mode: "number" }).notNull(),
  },
  () => [check("runner_account_capability_check_1", sql`protocol>=1`)],
);

export const agentAccountHealth = pgTable(
  "agent_account_health",
  {
    kind: text().notNull(),
    scope: text().notNull(),
    scopeId: text("scope_id").notNull(),
    model: text().default("").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    agent: text().notNull(),
    state: text().notNull(),
    source: text().notNull(),
    sourceId: text("source_id").notNull(),
    bindingId: text("binding_id")
      .notNull()
      .references(() => agentAccountBinding.id),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    observedAt: bigint("observed_at", { mode: "number" }).notNull(),
    resetsAt: bigint("resets_at", { mode: "number" }),
    nextCheckAt: bigint("next_check_at", { mode: "number" }),
    failures: bigint({ mode: "number" }).default(0).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.kind, table.scopeId, table.model],
      name: "agent_account_health_kind_scope_id_model_pk",
    }),
    index("agent_account_health_agent").on(table.workspaceId, table.agent, table.nextCheckAt),
    check("agent_account_health_check_1", sql`kind IN ('quota','auth','provider','model')`),
    check("agent_account_health_check_2", sql`scope IN ('account','binding','provider')`),
    check("agent_account_health_check_3", sql`length(scope_id) BETWEEN 1 AND 300`),
    check("agent_account_health_check_4", sql`length(model)<=200`),
    check("agent_account_health_check_5", sql`agent IN ('claude','codex','grok','opencode')`),
    check(
      "agent_account_health_check_6",
      sql`state IN ('ok','low','exhausted','auth_required','restricted','unsupported_model')`,
    ),
    check(
      "agent_account_health_check_7",
      sql`source IN ('result','login_check','sign_in','resume')`,
    ),
    check("agent_account_health_check_8", sql`length(source_id) BETWEEN 1 AND 200`),
    check("agent_account_health_check_9", sql`failures BETWEEN 0 AND 1000`),
    check("agent_account_health_check_10", sql`(kind='provider')=(scope='provider')`),
    check("agent_account_health_check_11", sql`kind='model' OR model=''`),
  ],
);
