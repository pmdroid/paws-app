import type { Database } from "bun:sqlite";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { JOB_KIND } from "../core";
import { listInFlightItems } from "./items";
import { mergeLaneSql } from "./jobs";
import { orm } from "./orm";
import { advanceOutboxSession, enqueueOutboxOnce } from "./outbox";
import {
  linearSession,
  linearStopReceipt,
  linearTurn,
  workItem,
  workspace,
  workspaceUser,
} from "./schema";
import { immediate } from "./tx";

export type StoredLinearSession = {
  sessionId: string;
  issueId: string | null;
  organizationId: string | null;
  appUserId: string | null;
  creatorId: string | null;
  delegationId: string | null;
  activeItemId: string | null;
  generation: number;
  stoppedAt: number | null;
};
export type StoredLinearTurn = {
  eventKey: string;
  activityId: string | null;
  sessionId: string;
  actorId: string | null;
  body: string;
  payload: string;
  createdAtMs: number;
  ordinal: number;
  itemId: string | null;
  state: "pending" | "applied" | "cancelled";
};

export function getLinearSession(db: Database, sessionId: string): StoredLinearSession | null {
  const row = orm(db)
    .select({
      sessionId: linearSession.sessionId,
      issueId: linearSession.issueId,
      organizationId: linearSession.organizationId,
      appUserId: linearSession.appUserId,
      creatorId: linearSession.creatorId,
      activeItemId: linearSession.activeItemId,
      generation: linearSession.generation,
      stoppedAt: linearSession.stoppedAt,
    })
    .from(linearSession)
    .where(eq(linearSession.sessionId, sessionId))
    .get();
  if (!row) return null;
  const linked = workItemForSession(db, sessionId);
  return {
    sessionId: row.sessionId,
    issueId: row.issueId,
    organizationId: row.organizationId,
    appUserId: row.appUserId,
    creatorId: row.creatorId,
    delegationId: linked?.delegationId ?? null,
    activeItemId: row.activeItemId,
    generation: row.generation,
    stoppedAt: row.stoppedAt,
  };
}

export function ensureLinearSession(
  db: Database,
  input: {
    sessionId: string;
    issueId?: string | null;
    organizationId?: string | null;
    appUserId?: string | null;
    creatorId?: string | null;
    now?: number;
  },
): StoredLinearSession {
  return immediate(db, () => {
    const existing = getLinearSession(db, input.sessionId);
    for (const field of ["issueId", "organizationId", "appUserId", "creatorId"] as const) {
      if (existing?.[field] && input[field] && existing[field] !== input[field])
        throw new Error(`Linear session ${field} ownership changed`);
    }
    orm(db)
      .insert(linearSession)
      .values({
        sessionId: input.sessionId,
        issueId: input.issueId ?? null,
        organizationId: input.organizationId ?? null,
        appUserId: input.appUserId ?? null,
        creatorId: input.creatorId ?? null,
        createdAt: input.now ?? Date.now(),
      })
      .onConflictDoUpdate({
        target: linearSession.sessionId,
        set: {
          issueId: sql`COALESCE(${linearSession.issueId}, excluded.issue_id)`,
          organizationId: sql`COALESCE(${linearSession.organizationId}, excluded.organization_id)`,
          appUserId: sql`COALESCE(${linearSession.appUserId}, excluded.app_user_id)`,
          creatorId: sql`COALESCE(${linearSession.creatorId}, excluded.creator_id)`,
        },
      })
      .run();
    return getLinearSession(db, input.sessionId)!;
  });
}

export function bindLinearSessionTask(
  db: Database,
  sessionId: string,
  delegationId: string,
  options: { actorId?: string | null } = {},
): void {
  immediate(db, () => {
    const current = getLinearSession(db, sessionId);
    if (!current) throw new Error("Linear session has not been recorded");
    if (current.delegationId && current.delegationId !== delegationId) {
      const active =
        orm(db)
          .select({ n: count() })
          .from(workItem)
          .where(
            and(
              eq(workItem.delegationId, current.delegationId),
              notInArray(workItem.state, ["merged", "cancelled", "completed"]),
            ),
          )
          .get()?.n ?? 0;
      if (active) throw new Error("Linear session already owns active work");
      orm(db)
        .update(linearSession)
        .set({ activeItemId: null })
        .where(eq(linearSession.sessionId, sessionId))
        .run();
    }
    orm(db)
      .update(workItem)
      .set({ sessionKey: sessionId })
      .where(
        and(
          eq(workItem.delegationId, delegationId),
          or(isNull(workItem.sessionKey), eq(workItem.sessionKey, sessionId)),
        ),
      )
      .run();
    const actorId = options.actorId ?? current.creatorId;
    const owner = actorId
      ? orm(db)
          .select({ id: workspaceUser.id })
          .from(workspaceUser)
          .where(eq(workspaceUser.linearUserId, actorId))
          .get()
      : null;
    const columns = orm(db)
      .all<{ name: string }>(sql`PRAGMA table_info(work_item)`)
      .map((column) => column.name);
    const ownerColumn = columns.includes("owner_user_id");
    const delegated = and(
      eq(workItem.delegationId, delegationId),
      eq(workItem.sessionKey, sessionId),
    );
    if (columns.includes("delegated_by"))
      orm(db)
        .update(workItem)
        .set({ delegatedBy: sql`COALESCE(${workItem.delegatedBy}, ${actorId})` })
        .where(delegated)
        .run();
    if (owner && ownerColumn)
      orm(db)
        .update(workItem)
        .set({ ownerUserId: owner.id })
        .where(and(delegated, isNull(workItem.ownerUserId)))
        .run();
  });
}

export function activateLinearItem(db: Database, sessionId: string, itemId: string): void {
  immediate(db, () => {
    const session = getLinearSession(db, sessionId);
    const item = orm(db)
      .select({ delegationId: workItem.delegationId, sessionKey: workItem.sessionKey })
      .from(workItem)
      .where(eq(workItem.id, itemId))
      .get();
    if (
      !session ||
      !item ||
      (session.delegationId !== null && session.delegationId !== item.delegationId)
    )
      throw new Error("Linear task route changed");
    if (session.activeItemId && session.activeItemId !== itemId) {
      if (listInFlightItems(db).some((entry) => entry.id === session.activeItemId))
        throw new Error("Previous Linear task is still active");
    }
    if (item.sessionKey && item.sessionKey !== sessionId)
      throw new Error("Active task cannot be rerouted to another Linear session");
    orm(db)
      .update(linearSession)
      .set({ activeItemId: itemId })
      .where(eq(linearSession.sessionId, sessionId))
      .run();
    orm(db).update(workItem).set({ sessionKey: sessionId }).where(eq(workItem.id, itemId)).run();
  });
}

export function workItemForSession(
  db: Database,
  sessionId: string,
): { id: string; delegationId: string; state: string } | null {
  return (
    orm(db)
      .select({ id: workItem.id, delegationId: workItem.delegationId, state: workItem.state })
      .from(workItem)
      .where(eq(workItem.sessionKey, sessionId))
      .orderBy(
        sql`CASE
          WHEN ${workItem.state} IN ('running','verifying','recovering','awaiting_input','paused','merge_queue') THEN 0
          WHEN ${workItem.state} IN ('queued','planning') THEN 1
          WHEN ${workItem.state} IN ('failed','manual') THEN 2
          ELSE 3 END`,
        desc(workItem.createdAt),
        desc(workItem.position),
        desc(workItem.id),
      )
      .limit(1)
      .get() ?? null
  );
}

/** The delegator rule shared by item reads and bulk access revocation. Aliases are internal SQL. */
export function delegatedLinearUserIdSql(item: string, session: string): string {
  return `COALESCE((SELECT u.linear_user_id FROM workspace_user u WHERE u.id=${item}.owner_user_id), ${item}.delegated_by, ${session}.creator_id)`;
}

export function delegatedLinearUserId(db: Database, itemId: string): string | null {
  const w = alias(workItem, "w");
  const s = alias(linearSession, "s");
  return (
    orm(db)
      .select({ actorId: sql<string | null>`${sql.raw(delegatedLinearUserIdSql("w", "s"))}` })
      .from(w)
      .leftJoin(s, eq(s.sessionId, w.sessionKey))
      .where(eq(w.id, itemId))
      .get()?.actorId ?? null
  );
}

export function recordLinearTurn(
  db: Database,
  input: {
    eventKey: string;
    activityId: string | null;
    sessionId: string;
    actorId: string | null;
    body: string;
    payload: string;
    createdAtMs: number;
    now?: number;
  },
): StoredLinearTurn {
  return immediate(db, () => {
    ensureLinearSession(db, { sessionId: input.sessionId, now: input.now });
    orm(db)
      .insert(linearTurn)
      .values({
        eventKey: input.eventKey,
        activityId: input.activityId,
        sessionId: input.sessionId,
        actorId: input.actorId,
        body: input.body,
        payload: input.payload,
        createdAtMs: input.createdAtMs,
        receivedAt: input.now ?? Date.now(),
      })
      .onConflictDoNothing()
      .run();
    const row = orm(db)
      .select()
      .from(linearTurn)
      .where(
        or(
          eq(linearTurn.eventKey, input.eventKey),
          sql`${linearTurn.activityId} = ${input.activityId}`,
        ),
      )
      .get()!;
    if (row.sessionId !== input.sessionId)
      throw new Error("Linear activity belongs to another session");
    if (!row.actorId && input.actorId) {
      orm(db)
        .update(linearTurn)
        .set({ actorId: input.actorId })
        .where(eq(linearTurn.eventKey, row.eventKey))
        .run();
      row.actorId = input.actorId;
    }
    return mapTurn(row);
  });
}

export function listPendingLinearTurns(db: Database, sessionId: string): StoredLinearTurn[] {
  return orm(db)
    .select()
    .from(linearTurn)
    .where(and(eq(linearTurn.sessionId, sessionId), eq(linearTurn.state, "pending")))
    .orderBy(asc(linearTurn.createdAtMs), asc(linearTurn.ordinal))
    .all()
    .map(mapTurn);
}

export function applyLinearTurns(
  db: Database,
  sessionId: string,
  eventKeys: readonly string[],
  itemId: string,
): void {
  immediate(db, () => {
    const linked = orm(db)
      .select({ sessionKey: workItem.sessionKey })
      .from(workItem)
      .where(eq(workItem.id, itemId))
      .get();
    if (linked?.sessionKey !== sessionId) throw new Error("Linear turn route is no longer active");
    for (const key of eventKeys)
      orm(db)
        .update(linearTurn)
        .set({ state: "applied", itemId })
        .where(
          and(
            eq(linearTurn.eventKey, key),
            eq(linearTurn.sessionId, sessionId),
            eq(linearTurn.state, "pending"),
          ),
        )
        .run();
  });
}

export function getLinearSessionGeneration(db: Database, sessionId: string): number {
  return getLinearSession(db, sessionId)?.generation ?? 0;
}

export function advanceLinearSessionGeneration(
  db: Database,
  sessionId: string,
  options: { stop?: boolean; now?: number } = {},
): number {
  return immediate(db, () => {
    ensureLinearSession(db, { sessionId, now: options.now });
    const generation = advanceOutboxSession(db, "linear", sessionId, options);
    orm(db)
      .update(linearSession)
      .set({ generation, stoppedAt: options.stop ? (options.now ?? Date.now()) : null })
      .where(eq(linearSession.sessionId, sessionId))
      .run();
    if (options.stop)
      orm(db)
        .update(linearTurn)
        .set({ state: "cancelled" })
        .where(
          and(
            eq(linearTurn.sessionId, sessionId),
            eq(linearTurn.state, "pending"),
            lte(linearTurn.createdAtMs, options.now ?? Date.now()),
          ),
        )
        .run();
    return generation;
  });
}

function mapTurn(row: typeof linearTurn.$inferSelect): StoredLinearTurn {
  return {
    eventKey: row.eventKey,
    activityId: row.activityId,
    sessionId: row.sessionId,
    actorId: row.actorId,
    body: row.body,
    payload: row.payload,
    createdAtMs: row.createdAtMs,
    ordinal: row.ordinal,
    itemId: row.itemId,
    state: row.state as StoredLinearTurn["state"],
  };
}

export function listLinearTurnsForItem(db: Database, itemId: string): StoredLinearTurn[] {
  return orm(db)
    .select()
    .from(linearTurn)
    .where(and(eq(linearTurn.itemId, itemId), eq(linearTurn.state, "applied")))
    .orderBy(asc(linearTurn.createdAtMs), asc(linearTurn.ordinal))
    .all()
    .map(mapTurn);
}

export function getLinearTurnGeneration(
  db: Database,
  sessionId: string,
  eventKey: string,
  activityId: string | null,
): number | null {
  return (
    orm(db)
      .select({ announcedGeneration: linearTurn.announcedGeneration })
      .from(linearTurn)
      .where(
        and(
          eq(linearTurn.sessionId, sessionId),
          or(eq(linearTurn.eventKey, eventKey), sql`${linearTurn.activityId} = ${activityId}`),
        ),
      )
      .get()?.announcedGeneration ?? null
  );
}

export function announceLinearTurn(
  db: Database,
  sessionId: string,
  eventKey: string,
  now = Date.now(),
): boolean {
  return immediate(db, () => {
    const turn = orm(db)
      .select({
        announcedGeneration: linearTurn.announcedGeneration,
        state: linearTurn.state,
        createdAtMs: linearTurn.createdAtMs,
      })
      .from(linearTurn)
      .where(and(eq(linearTurn.eventKey, eventKey), eq(linearTurn.sessionId, sessionId)))
      .get();
    if (!turn || turn.state !== "pending" || turn.announcedGeneration !== null) return false;
    const session = getLinearSession(db, sessionId);
    if (
      session?.stoppedAt !== null &&
      session?.stoppedAt !== undefined &&
      turn.createdAtMs <= session.stoppedAt
    ) {
      orm(db)
        .update(linearTurn)
        .set({ state: "cancelled" })
        .where(eq(linearTurn.eventKey, eventKey))
        .run();
      return false;
    }
    const generation = advanceLinearSessionGeneration(db, sessionId, { now });
    orm(db)
      .update(linearTurn)
      .set({ announcedGeneration: generation })
      .where(eq(linearTurn.eventKey, eventKey))
      .run();
    enqueueOutboxOnce(db, {
      target: "linear",
      op: "activity",
      orderingKey: sessionId,
      generation,
      delivery: "critical",
      idempotencyKey: `turn:ack:${eventKey}`,
      payload: {
        sessionId,
        kind: "thought",
        body: "Received your update.",
        id: crypto.randomUUID(),
      },
      now,
    });
    return true;
  });
}

export function discardLinearTurns(
  db: Database,
  sessionId: string,
  eventKeys: readonly string[],
): void {
  immediate(db, () => {
    for (const eventKey of eventKeys)
      orm(db)
        .update(linearTurn)
        .set({ state: "cancelled" })
        .where(
          and(
            eq(linearTurn.sessionId, sessionId),
            eq(linearTurn.eventKey, eventKey),
            eq(linearTurn.state, "pending"),
          ),
        )
        .run();
  });
}

export function acceptLinearStop(
  db: Database,
  sessionId: string,
  eventKey: string,
  now: number,
): number | null {
  return immediate(db, () => {
    if (
      orm(db)
        .select({ one: sql`1` })
        .from(linearStopReceipt)
        .where(
          and(eq(linearStopReceipt.sessionId, sessionId), eq(linearStopReceipt.eventKey, eventKey)),
        )
        .get()
    )
      return null;
    const session = ensureLinearSession(db, { sessionId, now });
    const generation =
      session.stoppedAt === null
        ? advanceLinearSessionGeneration(db, sessionId, { stop: true, now })
        : session.generation;
    orm(db)
      .insert(linearStopReceipt)
      .values({ sessionId, eventKey, generation, createdAt: now })
      .run();
    return generation;
  });
}

export function releaseIdleSessionItem(db: Database, itemId: string, now: number): void {
  orm(db)
    .update(linearSession)
    .set({ activeItemId: null })
    .where(
      and(
        eq(linearSession.activeItemId, itemId),
        sql`NOT EXISTS(SELECT 1 FROM run WHERE item_id=${itemId} AND status IN ('active','provisioning'))
       AND NOT EXISTS(SELECT 1 FROM job WHERE status='running' AND (locked_until IS NULL OR locked_until>${now})
         AND json_extract(payload,'$.itemId')=${itemId}
         AND (queue IN (${sql.raw(`'${JOB_KIND.start}','${JOB_KIND.resume}','${JOB_KIND.reverify}'`)}) OR ${sql.raw(mergeLaneSql("job"))}))`,
      ),
    )
    .run();
}

export function linearSessionClientId(db: Database, sessionId: string): string | null {
  return (
    orm(db)
      .select({ clientId: linearSession.oauthClientId })
      .from(linearSession)
      .where(eq(linearSession.sessionId, sessionId))
      .get()?.clientId ?? null
  );
}

export function linearSessionInWorkspace(
  db: Database,
  sessionId: string,
  workspaceId: string,
): boolean {
  return (
    orm(db)
      .select({ one: sql`1` })
      .from(linearSession)
      .innerJoin(workspace, eq(workspace.linearOrganizationId, linearSession.organizationId))
      .where(and(eq(linearSession.sessionId, sessionId), eq(workspace.id, workspaceId)))
      .get() !== undefined
  );
}

export function sessionActiveRuns(
  db: Database,
  sessionId: string,
): { itemId: string; runId: string }[] {
  return orm(db)
    .select({ itemId: workItem.id, runId: sql<string>`${workItem.currentRunId}` })
    .from(workItem)
    .where(
      and(
        eq(workItem.sessionKey, sessionId),
        isNotNull(workItem.currentRunId),
        inArray(workItem.state, ["running", "verifying", "recovering"]),
      ),
    )
    .limit(2)
    .all();
}
