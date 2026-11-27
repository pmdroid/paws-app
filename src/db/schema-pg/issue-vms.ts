import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspace, workspaceUser } from "./workspace";
import { workItem } from "./items";
import { runner } from "./runners";

export const issueVm = pgTable(
  "issue_vm",
  {
    id: text().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    memberUserId: text("member_user_id")
      .notNull()
      .references(() => workspaceUser.id),
    provider: text().notNull(),
    hostRunnerId: text("host_runner_id").references(() => runner.id),
    runnerId: text("runner_id").references(() => runner.id),
    state: text().notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    stateAt: bigint("state_at", { mode: "number" }).notNull(),
    deletedAt: bigint("deleted_at", { mode: "number" }),
    want: text().notNull().default("awake"),
    operation: text(),
    deadlineAt: bigint("deadline_at", { mode: "number" }),
    generation: integer().notNull().default(0),
    failure: text(),
    unitRunning: boolean("unit_running"),
    unitSeenAt: bigint("unit_seen_at", { mode: "number" }),
    sleepRefusal: text("sleep_refusal"),
    sleepRefusedAt: bigint("sleep_refused_at", { mode: "number" }),
  },
  (table) => [
    uniqueIndex("issue_vm_item_live")
      .on(table.itemId)
      .where(sql`state NOT IN ('deleted','failed')`),
    index("issue_vm_workspace_member").on(table.workspaceId, table.memberUserId),
    check("issue_vm_provider", sql`provider IN ('exe-dev','boat','instabox','host')`),
    check(
      "issue_vm_state",
      sql`state IN ('creating','awake','asleep','unknown','deleting','deleted','failed')`,
    ),
    check("issue_vm_want", sql`want IN ('awake','asleep')`),
    check("issue_vm_operation", sql`operation IN ('create','wake','sleep')`),
  ],
);

export const issueVmGrant = pgTable(
  "issue_vm_grant",
  {
    id: text().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    memberUserId: text("member_user_id")
      .notNull()
      .references(() => workspaceUser.id),
    limit: integer().notNull(),
    endsAt: bigint("ends_at", { mode: "number" }).notNull(),
    grantedBy: text("granted_by")
      .notNull()
      .references(() => workspaceUser.id),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    revokedAt: bigint("revoked_at", { mode: "number" }),
  },
  (table) => [
    index("issue_vm_grant_workspace_member").on(table.workspaceId, table.memberUserId),
    check("issue_vm_grant_limit", sql`"limit" BETWEEN 1 AND 50`),
  ],
);

export const issueVmAwake = pgTable(
  "issue_vm_awake",
  {
    id: text().primaryKey(),
    issueVmId: text("issue_vm_id")
      .notNull()
      .references(() => issueVm.id),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    endedAt: bigint("ended_at", { mode: "number" }),
    hourlyUsd: doublePrecision("hourly_usd"),
  },
  (table) => [
    uniqueIndex("issue_vm_awake_open")
      .on(table.issueVmId)
      .where(sql`ended_at IS NULL`),
    index("issue_vm_awake_started").on(table.startedAt),
  ],
);

export const issueVmSpend = pgTable("issue_vm_spend", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspace.id),
  monthlyLimitUsd: doublePrecision("monthly_limit_usd").notNull(),
  boatHourlyUsd: doublePrecision("boat_hourly_usd"),
  instaboxHourlyUsd: doublePrecision("instabox_hourly_usd"),
  updatedBy: text("updated_by").references(() => workspaceUser.id),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});
