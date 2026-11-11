import type { Database } from "bun:sqlite";
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { IN_FLIGHT_ITEM_STATES, JOB_KIND, parentIssueIdSql } from "../core";
import { settled, sqliteDb, type Db, type Q, type Steps } from "./db";
import { mergeLaneSql } from "./jobs";
import { advanceOutboxSessionSteps, enqueueOutboxOnceSteps } from "./outbox";

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

export function* getLinearSessionSteps(q: Q, sessionId: string): Steps<StoredLinearSession | null> {
  const { linearSession } = q.t;
  const row = yield* q.one(
    q.orm
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
      .where(eq(linearSession.sessionId, sessionId)),
  );
  if (!row) return null;
  const linked = yield* workItemForSessionSteps(q, sessionId);
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

export async function getLinearSession(
  store: Db,
  sessionId: string,
): Promise<StoredLinearSession | null> {
  return store.run((q) => getLinearSessionSteps(q, sessionId));
}

/** The Linear team and OAuth client a session was observed under, or null without a session. */
export function* linearSessionInstallationSteps(q: Q, sessionId: string) {
  const { linearSession: s } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ teamId: s.teamId, clientId: s.oauthClientId })
      .from(s)
      .where(eq(s.sessionId, sessionId)),
  );
  return row ?? null;
}

export async function linearSessionInstallation(
  store: Db,
  sessionId: string,
): Promise<{ teamId: string | null; clientId: string | null } | null> {
  return store.run((q) => linearSessionInstallationSteps(q, sessionId));
}

type LinearSessionInput = {
  sessionId: string;
  issueId?: string | null;
  organizationId?: string | null;
  appUserId?: string | null;
  creatorId?: string | null;
  now?: number;
};

export function* ensureLinearSessionSteps(
  q: Q,
  input: LinearSessionInput,
): Steps<StoredLinearSession> {
  const { linearSession } = q.t;
  const existing = yield* getLinearSessionSteps(q, input.sessionId);
  for (const field of ["issueId", "organizationId", "appUserId", "creatorId"] as const) {
    if (existing?.[field] && input[field] && existing[field] !== input[field])
      throw new Error(`Linear session ${field} ownership changed`);
  }
  yield* q.exec(
    q.orm
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
      }),
  );
  return (yield* getLinearSessionSteps(q, input.sessionId))!;
}

export async function ensureLinearSession(
  store: Db,
  input: LinearSessionInput,
): Promise<StoredLinearSession> {
  return store.transaction((q) => ensureLinearSessionSteps(q, input));
}

export function* bindLinearSessionTaskSteps(
  q: Q,
  sessionId: string,
  delegationId: string,
  options: { actorId?: string | null } = {},
): Steps<void> {
  const { linearSession, workItem, workspaceUser } = q.t;
  const current = yield* getLinearSessionSteps(q, sessionId);
  if (!current) throw new Error("Linear session has not been recorded");
  if (current.delegationId && current.delegationId !== delegationId) {
    const active = yield* q.one(
      q.orm
        .select({ n: count() })
        .from(workItem)
        .where(
          and(
            eq(workItem.delegationId, current.delegationId),
            notInArray(workItem.state, ["merged", "cancelled", "completed"]),
          ),
        ),
    );
    if (active?.n) throw new Error("Linear session already owns active work");
    yield* q.exec(
      q.orm
        .update(linearSession)
        .set({ activeItemId: null })
        .where(eq(linearSession.sessionId, sessionId)),
    );
  }
  yield* q.exec(
    q.orm
      .update(workItem)
      .set({ sessionKey: sessionId })
      .where(
        and(
          eq(workItem.delegationId, delegationId),
          or(isNull(workItem.sessionKey), eq(workItem.sessionKey, sessionId)),
        ),
      ),
  );
  const actorId = options.actorId ?? current.creatorId;
  const owner = actorId
    ? yield* q.one(
        q.orm
          .select({ id: workspaceUser.id })
          .from(workspaceUser)
          .where(eq(workspaceUser.linearUserId, actorId)),
      )
    : null;
  const delegated = and(
    eq(workItem.delegationId, delegationId),
    eq(workItem.sessionKey, sessionId),
  );
  yield* q.exec(
    q.orm
      .update(workItem)
      .set({ delegatedBy: sql`COALESCE(${workItem.delegatedBy}, ${actorId})` })
      .where(delegated),
  );
  if (owner)
    yield* q.exec(
      q.orm
        .update(workItem)
        .set({ ownerUserId: owner.id })
        .where(and(delegated, isNull(workItem.ownerUserId))),
    );
}

export async function bindLinearSessionTask(
  store: Db,
  sessionId: string,
  delegationId: string,
  options: { actorId?: string | null } = {},
): Promise<void> {
  await store.transaction((q) => bindLinearSessionTaskSteps(q, sessionId, delegationId, options));
}

export function* activateLinearItemSteps(q: Q, sessionId: string, itemId: string): Steps<void> {
  const { linearSession, workItem } = q.t;
  const session = yield* getLinearSessionSteps(q, sessionId);
  const item = yield* q.one(
    q.orm
      .select({ delegationId: workItem.delegationId, sessionKey: workItem.sessionKey })
      .from(workItem)
      .where(eq(workItem.id, itemId)),
  );
  if (
    !session ||
    !item ||
    (session.delegationId !== null && session.delegationId !== item.delegationId)
  )
    throw new Error("Linear task route changed");
  if (session.activeItemId && session.activeItemId !== itemId) {
    const previous = yield* q.one(
      q.orm
        .select({ id: workItem.id })
        .from(workItem)
        .where(
          and(
            eq(workItem.id, session.activeItemId),
            inArray(workItem.state, [...IN_FLIGHT_ITEM_STATES]),
          ),
        ),
    );
    if (previous) throw new Error("Previous Linear task is still active");
  }
  if (item.sessionKey && item.sessionKey !== sessionId)
    throw new Error("Active task cannot be rerouted to another Linear session");
  yield* q.exec(
    q.orm
      .update(linearSession)
      .set({ activeItemId: itemId })
      .where(eq(linearSession.sessionId, sessionId)),
  );
  yield* q.exec(
    q.orm.update(workItem).set({ sessionKey: sessionId }).where(eq(workItem.id, itemId)),
  );
}

export async function activateLinearItem(
  store: Db,
  sessionId: string,
  itemId: string,
): Promise<void> {
  await store.transaction((q) => activateLinearItemSteps(q, sessionId, itemId));
}

type SessionWorkItem = { id: string; delegationId: string; state: string };

export function* workItemForSessionSteps(q: Q, sessionId: string): Steps<SessionWorkItem | null> {
  const { workItem } = q.t;
  const row = yield* q.one(
    q.orm
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
      .limit(1),
  );
  return row ?? null;
}

export async function workItemForSession(
  store: Db,
  sessionId: string,
): Promise<SessionWorkItem | null> {
  return store.run((q) => workItemForSessionSteps(q, sessionId));
}

/** The delegator rule shared by item reads and bulk access revocation. Aliases are internal SQL. */
export function delegatedLinearUserIdSql(item: string, session: string): string {
  return `COALESCE((SELECT u.linear_user_id FROM workspace_user u WHERE u.id=${item}.owner_user_id), ${item}.delegated_by, ${session}.creator_id)`;
}

export function* delegatedLinearUserIdSteps(q: Q, itemId: string): Steps<string | null> {
  const { linearSession, workItem } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        actorId: sql<
          string | null
        >`${sql.raw(delegatedLinearUserIdSql("work_item", "linear_session"))}`,
      })
      .from(workItem)
      .leftJoin(linearSession, eq(linearSession.sessionId, workItem.sessionKey))
      .where(eq(workItem.id, itemId)),
  );
  return row?.actorId ?? null;
}

export async function delegatedLinearUserId(store: Db, itemId: string): Promise<string | null> {
  return store.run((q) => delegatedLinearUserIdSteps(q, itemId));
}

type LinearTurnInput = {
  eventKey: string;
  activityId: string | null;
  sessionId: string;
  actorId: string | null;
  body: string;
  payload: string;
  createdAtMs: number;
  now?: number;
};

export function* recordLinearTurnSteps(q: Q, input: LinearTurnInput): Steps<StoredLinearTurn> {
  const { linearTurn } = q.t;
  yield* ensureLinearSessionSteps(q, { sessionId: input.sessionId, now: input.now });
  yield* q.exec(
    q.orm
      .insert(linearTurn)
      .values({
        eventKey: input.eventKey,
        activityId: input.activityId,
        sessionId: input.sessionId,
        actorId: input.actorId,
        body: input.body,
        payload: q.dialect === "postgres" ? JSON.parse(input.payload) : input.payload,
        createdAtMs: input.createdAtMs,
        receivedAt: input.now ?? Date.now(),
      })
      .onConflictDoNothing(),
  );
  const row = (yield* q.one(
    q.orm
      .select()
      .from(linearTurn)
      .where(
        or(
          eq(linearTurn.eventKey, input.eventKey),
          sql`${linearTurn.activityId} = ${input.activityId}`,
        ),
      ),
  ))!;
  if (row.sessionId !== input.sessionId)
    throw new Error("Linear activity belongs to another session");
  if (!row.actorId && input.actorId) {
    yield* q.exec(
      q.orm
        .update(linearTurn)
        .set({ actorId: input.actorId })
        .where(eq(linearTurn.eventKey, row.eventKey)),
    );
    row.actorId = input.actorId;
  }
  return mapTurn(row);
}

export async function recordLinearTurn(
  store: Db,
  input: LinearTurnInput,
): Promise<StoredLinearTurn> {
  return store.transaction((q) => recordLinearTurnSteps(q, input));
}

export function* listPendingLinearTurnsSteps(q: Q, sessionId: string): Steps<StoredLinearTurn[]> {
  const { linearTurn } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(linearTurn)
      .where(and(eq(linearTurn.sessionId, sessionId), eq(linearTurn.state, "pending")))
      .orderBy(asc(linearTurn.createdAtMs), asc(linearTurn.ordinal)),
  );
  return rows.map(mapTurn);
}

export async function listPendingLinearTurns(
  store: Db,
  sessionId: string,
): Promise<StoredLinearTurn[]> {
  return store.run((q) => listPendingLinearTurnsSteps(q, sessionId));
}

export function* applyLinearTurnsSteps(
  q: Q,
  sessionId: string,
  eventKeys: readonly string[],
  itemId: string,
): Steps<void> {
  const { linearTurn, workItem } = q.t;
  const linked = yield* q.one(
    q.orm.select({ sessionKey: workItem.sessionKey }).from(workItem).where(eq(workItem.id, itemId)),
  );
  if (linked?.sessionKey !== sessionId) throw new Error("Linear turn route is no longer active");
  for (const key of eventKeys)
    yield* q.exec(
      q.orm
        .update(linearTurn)
        .set({ state: "applied", itemId })
        .where(
          and(
            eq(linearTurn.eventKey, key),
            eq(linearTurn.sessionId, sessionId),
            eq(linearTurn.state, "pending"),
          ),
        ),
    );
}

export async function applyLinearTurns(
  store: Db,
  sessionId: string,
  eventKeys: readonly string[],
  itemId: string,
): Promise<void> {
  await store.transaction((q) => applyLinearTurnsSteps(q, sessionId, eventKeys, itemId));
}

export function* getLinearSessionGenerationSteps(q: Q, sessionId: string): Steps<number> {
  return (yield* getLinearSessionSteps(q, sessionId))?.generation ?? 0;
}

export function getLinearSessionGeneration(db: Database, sessionId: string): number {
  return settled(sqliteDb(db).run((q) => getLinearSessionGenerationSteps(q, sessionId)));
}

// SQLite's write transaction serializes these operations. Postgres needs the same
// session-wide exclusion before any turn, receipt or stopped-generation reads.
function* lockLinearSessionSteps(q: Q, sessionId: string): Steps<void> {
  if (q.dialect === "postgres")
    yield* q.exec(
      q.orm
        .select({
          lock: sql`pg_advisory_xact_lock(hashtextextended(${`linear-session:${sessionId}`}, 0))`,
        })
        .from(sql`(SELECT 1) AS lock_scope`),
    );
}

export function* advanceLinearSessionGenerationSteps(
  q: Q,
  sessionId: string,
  options: { stop?: boolean; now?: number } = {},
): Steps<number> {
  yield* lockLinearSessionSteps(q, sessionId);
  yield* ensureLinearSessionSteps(q, { sessionId, now: options.now });
  const generation = yield* advanceOutboxSessionSteps(q, "linear", sessionId, options);
  yield* q.exec(
    q.orm
      .update(q.t.linearSession)
      .set({ generation, stoppedAt: options.stop ? (options.now ?? Date.now()) : null })
      .where(eq(q.t.linearSession.sessionId, sessionId)),
  );
  if (options.stop)
    yield* q.exec(
      q.orm
        .update(q.t.linearTurn)
        .set({ state: "cancelled" })
        .where(
          and(
            eq(q.t.linearTurn.sessionId, sessionId),
            eq(q.t.linearTurn.state, "pending"),
            lte(q.t.linearTurn.createdAtMs, options.now ?? Date.now()),
          ),
        ),
    );
  return generation;
}

export async function advanceLinearSessionGeneration(
  store: Db,
  sessionId: string,
  options: { stop?: boolean; now?: number } = {},
): Promise<number> {
  return await store.transaction((q) => advanceLinearSessionGenerationSteps(q, sessionId, options));
}

function mapTurn(row: Q["t"]["linearTurn"]["$inferSelect"]): StoredLinearTurn {
  return {
    eventKey: row.eventKey,
    activityId: row.activityId,
    sessionId: row.sessionId,
    actorId: row.actorId,
    body: row.body,
    payload: typeof row.payload === "string" ? row.payload : JSON.stringify(row.payload),
    createdAtMs: row.createdAtMs,
    ordinal: row.ordinal,
    itemId: row.itemId,
    state: row.state as StoredLinearTurn["state"],
  };
}

export function* listLinearTurnsForItemSteps(q: Q, itemId: string): Steps<StoredLinearTurn[]> {
  const { linearTurn } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(linearTurn)
      .where(and(eq(linearTurn.itemId, itemId), eq(linearTurn.state, "applied")))
      .orderBy(asc(linearTurn.createdAtMs), asc(linearTurn.ordinal)),
  );
  return rows.map(mapTurn);
}

export function listLinearTurnsForItem(db: Database, itemId: string): StoredLinearTurn[] {
  return settled(sqliteDb(db).run((q) => listLinearTurnsForItemSteps(q, itemId)));
}

export function* getLinearTurnGenerationSteps(
  q: Q,
  sessionId: string,
  eventKey: string,
  activityId: string | null,
): Steps<number | null> {
  const { linearTurn } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ announcedGeneration: linearTurn.announcedGeneration })
      .from(linearTurn)
      .where(
        and(
          eq(linearTurn.sessionId, sessionId),
          or(eq(linearTurn.eventKey, eventKey), sql`${linearTurn.activityId} = ${activityId}`),
        ),
      ),
  );
  return row?.announcedGeneration ?? null;
}

export async function getLinearTurnGeneration(
  store: Db,
  sessionId: string,
  eventKey: string,
  activityId: string | null,
): Promise<number | null> {
  return store.run((q) => getLinearTurnGenerationSteps(q, sessionId, eventKey, activityId));
}

export function* announceLinearTurnSteps(
  q: Q,
  sessionId: string,
  eventKey: string,
  now = Date.now(),
): Steps<boolean> {
  yield* lockLinearSessionSteps(q, sessionId);
  const turn = yield* q.one(
    q.orm
      .select({
        announcedGeneration: q.t.linearTurn.announcedGeneration,
        state: q.t.linearTurn.state,
        createdAtMs: q.t.linearTurn.createdAtMs,
      })
      .from(q.t.linearTurn)
      .where(and(eq(q.t.linearTurn.eventKey, eventKey), eq(q.t.linearTurn.sessionId, sessionId))),
  );
  if (!turn || turn.state !== "pending" || turn.announcedGeneration !== null) return false;
  const session = yield* getLinearSessionSteps(q, sessionId);
  if (
    session?.stoppedAt !== null &&
    session?.stoppedAt !== undefined &&
    turn.createdAtMs <= session.stoppedAt
  ) {
    yield* q.exec(
      q.orm
        .update(q.t.linearTurn)
        .set({ state: "cancelled" })
        .where(eq(q.t.linearTurn.eventKey, eventKey)),
    );
    return false;
  }
  const generation = yield* advanceLinearSessionGenerationSteps(q, sessionId, { now });
  yield* q.exec(
    q.orm
      .update(q.t.linearTurn)
      .set({ announcedGeneration: generation })
      .where(eq(q.t.linearTurn.eventKey, eventKey)),
  );
  yield* enqueueOutboxOnceSteps(q, {
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
}

export async function announceLinearTurn(
  store: Db,
  sessionId: string,
  eventKey: string,
  now = Date.now(),
): Promise<boolean> {
  return await store.transaction((q) => announceLinearTurnSteps(q, sessionId, eventKey, now));
}

export function* discardLinearTurnsSteps(
  q: Q,
  sessionId: string,
  eventKeys: readonly string[],
): Steps<void> {
  const { linearTurn } = q.t;
  for (const eventKey of eventKeys)
    yield* q.exec(
      q.orm
        .update(linearTurn)
        .set({ state: "cancelled" })
        .where(
          and(
            eq(linearTurn.sessionId, sessionId),
            eq(linearTurn.eventKey, eventKey),
            eq(linearTurn.state, "pending"),
          ),
        ),
    );
}

export async function discardLinearTurns(
  store: Db,
  sessionId: string,
  eventKeys: readonly string[],
): Promise<void> {
  await store.transaction((q) => discardLinearTurnsSteps(q, sessionId, eventKeys));
}

export function* acceptLinearStopSteps(
  q: Q,
  sessionId: string,
  eventKey: string,
  now: number,
): Steps<number | null> {
  yield* lockLinearSessionSteps(q, sessionId);
  if (
    yield* q.one(
      q.orm
        .select({ one: sql`1` })
        .from(q.t.linearStopReceipt)
        .where(
          and(
            eq(q.t.linearStopReceipt.sessionId, sessionId),
            eq(q.t.linearStopReceipt.eventKey, eventKey),
          ),
        ),
    )
  )
    return null;
  const session = yield* ensureLinearSessionSteps(q, { sessionId, now });
  const generation =
    session.stoppedAt === null
      ? yield* advanceLinearSessionGenerationSteps(q, sessionId, { stop: true, now })
      : session.generation;
  yield* q.exec(
    q.orm.insert(q.t.linearStopReceipt).values({ sessionId, eventKey, generation, createdAt: now }),
  );
  return generation;
}

export async function acceptLinearStop(
  store: Db,
  sessionId: string,
  eventKey: string,
  now: number,
): Promise<number | null> {
  return await store.transaction((q) => acceptLinearStopSteps(q, sessionId, eventKey, now));
}

export function* releaseIdleSessionItemSteps(q: Q, itemId: string, now: number): Steps<void> {
  const { linearSession } = q.t;
  const jobItemId =
    q.dialect === "postgres" ? sql`payload->>'itemId'` : sql`json_extract(payload,'$.itemId')`;
  yield* q.exec(
    q.orm
      .update(linearSession)
      .set({ activeItemId: null })
      .where(
        and(
          eq(linearSession.activeItemId, itemId),
          sql`NOT EXISTS(SELECT 1 FROM run WHERE item_id=${itemId} AND status IN ('active','provisioning'))
       AND NOT EXISTS(SELECT 1 FROM job WHERE status='running' AND (locked_until IS NULL OR locked_until>${now})
         AND ${jobItemId}=${itemId}
         AND (queue IN (${sql.raw(`'${JOB_KIND.start}','${JOB_KIND.resume}','${JOB_KIND.reverify}'`)}) OR ${sql.raw(mergeLaneSql("job"))}))`,
        ),
      ),
  );
}

export async function releaseIdleSessionItem(
  store: Db,
  itemId: string,
  now: number,
): Promise<void> {
  await store.run((q) => releaseIdleSessionItemSteps(q, itemId, now));
}

export function* linearSessionClientIdSteps(q: Q, sessionId: string): Steps<string | null> {
  const { linearSession } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ clientId: linearSession.oauthClientId })
      .from(linearSession)
      .where(eq(linearSession.sessionId, sessionId)),
  );
  return row?.clientId ?? null;
}

export async function linearSessionClientId(store: Db, sessionId: string): Promise<string | null> {
  return store.run((q) => linearSessionClientIdSteps(q, sessionId));
}

export function* linearSessionInWorkspaceSteps(
  q: Q,
  sessionId: string,
  workspaceId: string,
): Steps<boolean> {
  const { linearSession, workspace } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(linearSession)
      .innerJoin(workspace, eq(workspace.linearOrganizationId, linearSession.organizationId))
      .where(and(eq(linearSession.sessionId, sessionId), eq(workspace.id, workspaceId))),
  );
  return row !== undefined;
}

export async function linearSessionInWorkspace(
  store: Db,
  sessionId: string,
  workspaceId: string,
): Promise<boolean> {
  return store.run((q) => linearSessionInWorkspaceSteps(q, sessionId, workspaceId));
}

type SessionRun = { itemId: string; runId: string };

export function* sessionActiveRunsSteps(q: Q, sessionId: string): Steps<SessionRun[]> {
  const { workItem } = q.t;
  return yield* q.all(
    q.orm
      .select({ itemId: workItem.id, runId: sql<string>`${workItem.currentRunId}` })
      .from(workItem)
      .where(
        and(
          eq(workItem.sessionKey, sessionId),
          isNotNull(workItem.currentRunId),
          inArray(workItem.state, ["running", "verifying", "recovering"]),
        ),
      )
      .limit(2),
  );
}

export async function sessionActiveRuns(store: Db, sessionId: string): Promise<SessionRun[]> {
  return store.run((q) => sessionActiveRunsSteps(q, sessionId));
}

export function* previousIssueSessionIdsSteps(
  q: Q,
  incomingSessionId: string,
  issueId: string,
): Steps<string[]> {
  const { linearSession, workItem } = q.t;
  const previous = alias(linearSession, "previous");
  const incoming = alias(linearSession, "incoming");
  const rows = yield* q.all(
    q.orm
      .selectDistinct({ sessionId: previous.sessionId })
      .from(workItem)
      .innerJoin(previous, eq(previous.sessionId, workItem.sessionKey))
      .innerJoin(
        incoming,
        and(
          eq(incoming.sessionId, incomingSessionId),
          eq(incoming.organizationId, previous.organizationId),
          eq(incoming.oauthClientId, previous.oauthClientId),
          eq(incoming.appUserId, previous.appUserId),
          eq(incoming.teamId, previous.teamId),
        ),
      )
      .where(
        and(
          eq(workItem.linearIssueId, issueId),
          ne(workItem.sessionKey, incoming.sessionId),
          notInArray(workItem.state, ["completed", "merged"]),
        ),
      ),
  );
  return rows.map((row) => row.sessionId);
}

export async function previousIssueSessionIds(
  store: Db,
  incomingSessionId: string,
  issueId: string,
): Promise<string[]> {
  return store.run((q) => previousIssueSessionIdsSteps(q, incomingSessionId, issueId));
}

type StoppedSessionItem = { id: string; sessionKey: string; delegationId: string };

export function* pausedStoppedSessionItemSteps(
  q: Q,
  incomingSessionId: string,
  issueId: string,
): Steps<StoppedSessionItem | null> {
  const { linearSession, workItem } = q.t;
  const previous = alias(linearSession, "previous");
  const incoming = alias(linearSession, "incoming");
  const same = (left: unknown, right: unknown) => sql`${left} IS NOT DISTINCT FROM ${right}`;
  const row = yield* q.one(
    q.orm
      .select({
        id: workItem.id,
        sessionKey: workItem.sessionKey,
        delegationId: workItem.delegationId,
      })
      .from(workItem)
      .innerJoin(previous, eq(previous.sessionId, workItem.sessionKey))
      .innerJoin(
        incoming,
        and(
          eq(incoming.sessionId, incomingSessionId),
          same(incoming.organizationId, previous.organizationId),
          same(incoming.oauthClientId, previous.oauthClientId),
          same(incoming.appUserId, previous.appUserId),
          same(incoming.teamId, previous.teamId),
        ),
      )
      .where(
        and(
          eq(workItem.linearIssueId, issueId),
          eq(workItem.state, "paused"),
          isNotNull(previous.stoppedAt),
          ne(previous.sessionId, incoming.sessionId),
        ),
      )
      .orderBy(desc(workItem.createdAt))
      .limit(1),
  );
  return row ? { ...row, sessionKey: row.sessionKey! } : null;
}

export async function pausedStoppedSessionItem(
  store: Db,
  incomingSessionId: string,
  issueId: string,
): Promise<StoppedSessionItem | null> {
  return store.run((q) => pausedStoppedSessionItemSteps(q, incomingSessionId, issueId));
}

type LinearTurnKey = { sessionId: string; eventKey: string };

export function* rewritePendingLinearTurnSteps(q: Q, turn: LinearTurnKey, body: string) {
  const { linearTurn } = q.t;
  yield* q.exec(
    q.orm
      .update(linearTurn)
      .set({ body })
      .where(
        and(
          eq(linearTurn.sessionId, turn.sessionId),
          eq(linearTurn.eventKey, turn.eventKey),
          eq(linearTurn.state, "pending"),
        ),
      ),
  );
}

export async function rewritePendingLinearTurn(
  store: Db,
  turn: LinearTurnKey,
  body: string,
): Promise<void> {
  await store.run((q) => rewritePendingLinearTurnSteps(q, turn, body));
}

export function* deleteCancelledLinearTurnSteps(q: Q, turn: LinearTurnKey) {
  const { linearTurn } = q.t;
  yield* q.exec(
    q.orm
      .delete(linearTurn)
      .where(
        and(
          eq(linearTurn.sessionId, turn.sessionId),
          eq(linearTurn.eventKey, turn.eventKey),
          eq(linearTurn.state, "cancelled"),
        ),
      ),
  );
}

export async function deleteCancelledLinearTurn(store: Db, turn: LinearTurnKey): Promise<void> {
  await store.run((q) => deleteCancelledLinearTurnSteps(q, turn));
}

/** Whether Stop was recorded for a generation of this session newer than `generation`. */
export function* linearStoppedAfterSteps(q: Q, sessionId: string, generation: number) {
  const { linearStopReceipt } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(linearStopReceipt)
      .where(
        and(
          eq(linearStopReceipt.sessionId, sessionId),
          gt(linearStopReceipt.generation, generation),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

export async function linearStoppedAfter(
  store: Db,
  sessionId: string,
  generation: number,
): Promise<boolean> {
  return store.run((q) => linearStoppedAfterSteps(q, sessionId, generation));
}

/** The newest live session on this issue while a sub-issue delegated under it has open work. */
export function* parentIssueSessionSteps(q: Q, issueId: string) {
  const { linearSession } = q.t;
  const w = alias(q.t.workItem, "w");
  const row = yield* q.one(
    q.orm
      .select({ sessionId: linearSession.sessionId })
      .from(linearSession)
      .where(
        and(
          eq(linearSession.issueId, issueId),
          isNull(linearSession.stoppedAt),
          exists(
            q.orm
              .select({ one: sql`1` })
              .from(w)
              .where(
                and(
                  ne(w.linearIssueId, issueId),
                  sql`${sql.raw(parentIssueIdSql("w", q.dialect))} = ${issueId}`,
                  notInArray(w.state, ["completed", "merged", "cancelled"]),
                ),
              ),
          ),
        ),
      )
      .orderBy(desc(linearSession.createdAt))
      .limit(1),
  );
  return row?.sessionId ?? null;
}

export async function parentIssueSession(store: Db, issueId: string): Promise<string | null> {
  return store.run((q) => parentIssueSessionSteps(q, issueId));
}
