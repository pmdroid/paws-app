import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { jsonb } from "./types";

export const contextScope = pgTable(
  "context_scope",
  {
    workspaceId: text("workspace_id").notNull(),
    scopeKind: text("scope_kind").notNull(),
    scopeId: text("scope_id").notNull(),
    status: text().notNull(),
    generation: bigint({ mode: "number" }).notNull(),
    changedAt: bigint("changed_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.scopeKind, table.scopeId],
      name: "context_scope_pk",
    }),
    check(
      "context_scope_kind",
      sql`scope_kind IN ('linear_project','slack_channel','user_private')`,
    ),
    check("context_scope_status", sql`status IN ('connected','disconnected')`),
  ],
);

export const contextSource = pgTable(
  "context_source",
  {
    workspaceId: text("workspace_id").notNull(),
    scopeKind: text("scope_kind").notNull(),
    scopeId: text("scope_id").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    status: text().notNull(),
    revision: text(),
    revisionAt: bigint("revision_at", { mode: "number" }),
    blockedThrough: bigint("blocked_through", { mode: "number" }),
    restriction: jsonb().notNull(),
    changedBy: text("changed_by"),
    changedAt: bigint("changed_at", { mode: "number" }).notNull(),
    verifiedAt: bigint("verified_at", { mode: "number" }),
  },
  (table) => [
    primaryKey({
      columns: [
        table.workspaceId,
        table.scopeKind,
        table.scopeId,
        table.sourceKind,
        table.sourceId,
      ],
      name: "context_source_pk",
    }),
    check(
      "context_source_status",
      sql`status IN ('active','unverified','forgotten','deleted','revoked','expired','disconnected')`,
    ),
  ],
);

export const contextRecord = pgTable(
  "context_record",
  {
    id: text().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    scopeKind: text("scope_kind").notNull(),
    scopeId: text("scope_id").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    sourceUrl: text("source_url"),
    sourceRevision: text("source_revision").notNull(),
    sourceRevisionAt: bigint("source_revision_at", { mode: "number" }).notNull(),
    actorId: text("actor_id"),
    observedAt: bigint("observed_at", { mode: "number" }).notNull(),
    recordKey: text("record_key").notNull(),
    layer: text().notNull(),
    classification: text().notNull(),
    importance: integer().notNull(),
    body: text().notNull(),
    bodyBytes: integer("body_bytes").notNull(),
    contentHash: text("content_hash").notNull(),
    audience: text().notNull(),
    audienceLineage: text("audience_lineage").notNull(),
    restriction: jsonb().notNull(),
    version: integer().notNull(),
    status: text().notNull(),
    supersedes: text(),
    correctedBy: text("corrected_by"),
    invalidatedReason: text("invalidated_reason"),
    invalidatedAt: bigint("invalidated_at", { mode: "number" }),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("context_record_version").on(
      table.workspaceId,
      table.scopeKind,
      table.scopeId,
      table.sourceKind,
      table.sourceId,
      table.recordKey,
      table.version,
    ),
    uniqueIndex("context_record_current")
      .on(
        table.workspaceId,
        table.scopeKind,
        table.scopeId,
        table.sourceKind,
        table.sourceId,
        table.recordKey,
      )
      .where(sql`status = 'current'`),
    index("context_record_select").on(
      table.workspaceId,
      table.scopeKind,
      table.scopeId,
      table.status,
      table.importance,
      table.observedAt,
    ),
    index("context_record_workspace").on(table.workspaceId, table.status),
    check("context_record_layer", sql`layer IN ('source_text','observation','summary')`),
    check(
      "context_record_classification",
      sql`classification IN ('decision','verified_fact','reported_fact','inference','unresolved_question')`,
    ),
    check("context_record_status", sql`status IN ('current','superseded','invalidated')`),
  ],
);

export const contextAudit = pgTable(
  "context_audit",
  {
    id: text().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    scopeKind: text("scope_kind").notNull(),
    scopeId: text("scope_id").notNull(),
    action: text().notNull(),
    actorId: text("actor_id"),
    sourceKind: text("source_kind"),
    sourceId: text("source_id"),
    at: bigint({ mode: "number" }).notNull(),
  },
  (table) => [index("context_audit_scope").on(table.workspaceId, table.scopeKind, table.scopeId)],
);

export const contextSummary = pgTable(
  "context_summary",
  {
    id: text().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    scopeKind: text("scope_kind").notNull(),
    scopeId: text("scope_id").notNull(),
    partition: text().notNull(),
    audience: text().notNull(),
    audienceLineage: text("audience_lineage").notNull(),
    restriction: jsonb().notNull(),
    version: integer().notNull(),
    status: text().notNull(),
    body: text().notNull(),
    bodyBytes: integer("body_bytes").notNull(),
    covered: integer().notNull(),
    watermark: bigint({ mode: "number" }),
    generation: bigint({ mode: "number" }),
    requestedAt: bigint("requested_at", { mode: "number" }),
    leaseToken: text("lease_token"),
    leaseUntil: bigint("lease_until", { mode: "number" }),
    claimedAt: bigint("claimed_at", { mode: "number" }),
    attempts: integer().notNull(),
    failure: text(),
    builtAt: bigint("built_at", { mode: "number" }),
    changedAt: bigint("changed_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("context_summary_partition").on(
      table.workspaceId,
      table.scopeKind,
      table.scopeId,
      table.partition,
    ),
    index("context_summary_requested").on(table.requestedAt),
    check("context_summary_status", sql`status IN ('empty','current','invalidated')`),
  ],
);

export const contextSummarySource = pgTable(
  "context_summary_source",
  {
    summaryId: text("summary_id").notNull(),
    recordId: text("record_id").notNull(),
    recordVersion: integer("record_version").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.summaryId, table.recordId], name: "context_summary_source_pk" }),
    index("context_summary_source_record").on(table.recordId),
  ],
);

export const contextSession = pgTable(
  "context_session",
  {
    consumerKey: text("consumer_key").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    scopeKind: text("scope_kind").notNull(),
    scopeId: text("scope_id").notNull(),
    requesterId: text("requester_id").notNull(),
    audience: text().notNull(),
    version: integer().notNull(),
    generation: bigint({ mode: "number" }).notNull(),
    status: text().notNull(),
    packHash: text("pack_hash").notNull(),
    manifest: jsonb().notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("context_session_scope").on(table.workspaceId, table.scopeKind, table.scopeId),
    check("context_session_status", sql`status IN ('injected','withheld')`),
    check("context_session_version", sql`version > 0`),
  ],
);
