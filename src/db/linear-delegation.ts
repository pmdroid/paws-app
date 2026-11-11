import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { delegationIssueIdSql } from "../core";
import { type Db, type Q, type Steps } from "./db";
import type { WorkItemRecord } from "./items";
import { enqueueOutboxOnceSteps } from "./outbox";

export type LinearTaskDelegation = {
  appUserId: string;
  humanActorId: string | null;
  teamId: string;
};

export function* getLinearTaskDelegationSteps(
  q: Q,
  itemId: string,
  issueId: string,
): Steps<LinearTaskDelegation | null> {
  const { linearTaskDelegation } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        appUserId: linearTaskDelegation.appUserId,
        humanActorId: linearTaskDelegation.humanActorId,
        teamId: linearTaskDelegation.teamId,
      })
      .from(linearTaskDelegation)
      .where(
        and(eq(linearTaskDelegation.itemId, itemId), eq(linearTaskDelegation.issueId, issueId)),
      ),
  );
  return row ?? null;
}

export async function getLinearTaskDelegation(
  store: Db,
  itemId: string,
  issueId: string,
): Promise<LinearTaskDelegation | null> {
  return store.run((q) => getLinearTaskDelegationSteps(q, itemId, issueId));
}

/**
 * Enqueue a Linear status change for the item's issue in the caller's transaction. An issue
 * delegated to Paws without a human actor is not Paws's to move, as in the orchestrator.
 * `fence` places the row in a stopped session: Stop drops and blocks every other delivery.
 */
export function* enqueueIssueStatusSteps(
  q: Q,
  item: Pick<WorkItemRecord, "id" | "linearIssueId" | "sessionKey" | "version">,
  stateType: "completed" | "canceled",
  now: number,
  fence?: { delivery: "stop"; generation: number },
): Steps<void> {
  const owner = yield* getLinearTaskDelegationSteps(q, item.id, item.linearIssueId);
  if (owner !== null && !owner.humanActorId) return;
  yield* enqueueOutboxOnceSteps(q, {
    target: "linear",
    op: "status",
    orderingKey: item.sessionKey ?? item.id,
    idempotencyKey: `status:${item.id}:${item.linearIssueId}:${stateType}:${item.version}`,
    payload: { itemId: item.id, linearIssueId: item.linearIssueId, stateType },
    ...fence,
    now,
  });
}

export async function enqueueIssueStatus(
  store: Db,
  item: Pick<WorkItemRecord, "id" | "linearIssueId" | "sessionKey" | "version">,
  stateType: "completed" | "canceled",
  now: number,
  fence?: { delivery: "stop"; generation: number },
): Promise<void> {
  await store.transaction((q) => enqueueIssueStatusSteps(q, item, stateType, now, fence));
}

type LinearTaskDelegationInput = {
  itemId: string;
  issueId: string;
  teamId: string;
  appUserId: string;
  humanActorId?: string | null;
};

export function* requireLinearTaskDelegationSteps(
  q: Q,
  input: LinearTaskDelegationInput,
): Steps<void> {
  const { linearTaskDelegation } = q.t;
  if ([input.itemId, input.issueId, input.teamId, input.appUserId].some((id) => id.trim() === ""))
    throw new Error("Linear delegation ownership is incomplete.");
  if (
    input.humanActorId !== undefined &&
    input.humanActorId !== null &&
    input.humanActorId.trim() === ""
  )
    throw new Error("Linear delegation human ownership is incomplete.");
  const existing = yield* getLinearTaskDelegationSteps(q, input.itemId, input.issueId);
  if (
    existing &&
    (existing.appUserId !== input.appUserId ||
      (existing.humanActorId !== null &&
        input.humanActorId != null &&
        existing.humanActorId !== input.humanActorId))
  )
    throw new Error("Linear delegation ownership changed.");
  yield* q.exec(
    q.orm
      .insert(linearTaskDelegation)
      .values({
        itemId: input.itemId,
        issueId: input.issueId,
        teamId: input.teamId,
        appUserId: input.appUserId,
        humanActorId: input.humanActorId ?? null,
      })
      .onConflictDoUpdate({
        target: [linearTaskDelegation.itemId, linearTaskDelegation.issueId],
        set: {
          teamId: sql`excluded.team_id`,
          humanActorId: sql`COALESCE(${linearTaskDelegation.humanActorId}, excluded.human_actor_id)`,
        },
      }),
  );
}

export async function requireLinearTaskDelegation(
  store: Db,
  input: LinearTaskDelegationInput,
): Promise<void> {
  await store.run((q) => requireLinearTaskDelegationSteps(q, input));
}

type DelegatedTeams = {
  organizationId: string;
  oauthClientId: string;
  appUserId: string;
  teamIds: readonly string[];
};

export function* linearSessionsForDelegatedTeamsSteps(
  q: Q,
  input: DelegatedTeams,
): Steps<string[]> {
  const { linearSession, linearTaskDelegation, linearTeamAccess, workItem } = q.t;
  const rows = yield* q.all(
    q.orm
      .selectDistinct({ sessionId: linearSession.sessionId })
      .from(linearTaskDelegation)
      .innerJoin(workItem, eq(workItem.id, linearTaskDelegation.itemId))
      .innerJoin(linearSession, eq(linearSession.sessionId, workItem.sessionKey))
      .innerJoin(
        linearTeamAccess,
        and(
          eq(linearTeamAccess.organizationId, linearSession.organizationId),
          eq(linearTeamAccess.oauthClientId, linearSession.oauthClientId),
          eq(linearTeamAccess.appUserId, linearSession.appUserId),
          eq(linearTeamAccess.teamId, linearTaskDelegation.teamId),
          eq(linearTeamAccess.allowed, 0),
        ),
      )
      .where(
        and(
          eq(linearSession.organizationId, input.organizationId),
          eq(linearSession.oauthClientId, input.oauthClientId),
          eq(linearSession.appUserId, input.appUserId),
          inArray(linearTaskDelegation.teamId, [...input.teamIds]),
        ),
      )
      .orderBy(linearSession.sessionId),
  );
  return rows.map((row) => row.sessionId);
}

export async function linearSessionsForDelegatedTeams(
  store: Db,
  input: DelegatedTeams,
): Promise<string[]> {
  return store.run((q) => linearSessionsForDelegatedTeamsSteps(q, input));
}

type UndelegatedIssue = {
  organizationId: string;
  appUserId: string;
  issueId: string;
  createdAtMs: number;
};

function delegationIssueId(q: Q, item: string) {
  if (q.dialect === "sqlite") return sql.raw(delegationIssueIdSql(item));
  const briefIssue = `${item}.brief #>> '{epic,issueId}'`;
  return sql.raw(
    `CASE WHEN ${briefIssue} IS NOT NULL AND ${briefIssue} <> ${item}.linear_issue_id THEN ${briefIssue} ELSE ${item}.linear_issue_id END`,
  );
}

export function* linearSessionsForUndelegatedIssueSteps(
  q: Q,
  input: UndelegatedIssue,
): Steps<string[]> {
  const { linearSession } = q.t;
  const { issueId, createdAtMs } = input;
  const rows = yield* q.all(
    q.orm
      .select({ sessionId: linearSession.sessionId })
      .from(linearSession)
      .where(
        and(
          eq(linearSession.organizationId, input.organizationId),
          eq(linearSession.appUserId, input.appUserId),
          isNull(linearSession.stoppedAt),
          lte(linearSession.createdAt, createdAtMs),
          sql`(EXISTS (SELECT 1 FROM work_item i WHERE i.session_key = linear_session.session_id
              AND i.state NOT IN ('completed', 'merged', 'cancelled') AND i.created_at <= ${createdAtMs}
              AND (linear_session.issue_id = ${issueId} OR i.linear_issue_id = ${issueId} OR ${delegationIssueId(q, "i")} = ${issueId}))
            OR (linear_session.issue_id = ${issueId} AND NOT EXISTS (SELECT 1 FROM work_item i WHERE i.session_key = linear_session.session_id)))`,
        ),
      )
      .orderBy(linearSession.sessionId),
  );
  return rows.map((row) => row.sessionId);
}

export async function linearSessionsForUndelegatedIssue(
  store: Db,
  input: UndelegatedIssue,
): Promise<string[]> {
  return store.run((q) => linearSessionsForUndelegatedIssueSteps(q, input));
}
