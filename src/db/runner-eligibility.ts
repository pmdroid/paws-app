import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";
import type { Q } from "./db";
import { jsonText } from "./json-text";

export function* eligibleRunnerRowsSteps(
  q: Q,
  workspaceId: string,
  agent: string,
  includeRevoked: boolean,
) {
  const { runner: r, runnerPolicy: p, runnerAgentPolicy: a } = q.t;
  return yield* q.all(
    q.orm
      .select({
        id: r.id,
        workspaceId: r.workspaceId,
        ownerId: r.ownerUserId,
        status: r.status,
        lastSeenAt: r.lastSeenAt,
        revokedAt: r.revokedAt,
        sharing: sql<number>`COALESCE(${p.sharing}, 0)`.mapWith(Number),
        ready: sql<number>`COALESCE(${a.ready}, 0)`.mapWith(Number),
        authExpired: sql<number>`COALESCE(${a.authExpired}, 0)`.mapWith(Number),
        quotaState: sql<string>`COALESCE(${a.quotaState}, 'ok')`,
        cooldownUntil: sql<number>`COALESCE(${a.cooldownUntil}, 0)`.mapWith(Number),
        virtualFinish: sql<number>`COALESCE(${a.virtualFinish}, 0)`.mapWith(Number),
        lastUsedAt: sql<number>`COALESCE(${a.lastUsedAt}, 0)`.mapWith(Number),
        resolvedModel: a.resolvedModel,
      })
      .from(r)
      .leftJoin(p, eq(p.runnerId, r.id))
      .leftJoin(a, and(eq(a.runnerId, r.id), eq(a.agent, agent)))
      .where(
        and(
          eq(r.workspaceId, workspaceId),
          includeRevoked ? undefined : and(isNull(r.revokedAt), ne(r.status, "revoked")),
        ),
      )
      .orderBy(asc(r.id)),
  );
}

export function* itemOwnerScopeRowSteps(q: Q, itemId: string) {
  const { workItem: i, linearSession: s, workspace: w } = q.t;
  return yield* q.one(
    q.orm
      .select({
        workspaceId: w.id,
        teamId: s.teamId,
        ownerUserId: i.ownerUserId,
        delegationId: i.delegationId,
      })
      .from(i)
      .leftJoin(s, eq(s.sessionId, i.sessionKey))
      .leftJoin(w, eq(w.linearOrganizationId, s.organizationId))
      .where(eq(i.id, itemId)),
  );
}

export function* delegationLeadUserIdsSteps(q: Q, delegationId: string) {
  const { workItem: i, workItemScheduling: c, workspaceUser: u } = q.t;
  const rows = yield* q.all(
    q.orm
      .selectDistinct({ id: u.id })
      .from(i)
      .innerJoin(c, eq(c.itemId, i.id))
      .innerJoin(u, eq(u.linearUserId, c.projectLeadId))
      .where(eq(i.delegationId, delegationId))
      .orderBy(asc(u.id)),
  );
  return rows.map((row) => row.id);
}

export function* lastItemRunnerSteps(q: Q, itemId: string) {
  const { run: r, runnerWork: w } = q.t;
  return yield* q.one(
    q.orm
      .select({ runnerId: w.runnerId, agent: r.agent })
      .from(r)
      .leftJoin(w, eq(w.runId, r.id))
      .where(eq(r.itemId, itemId))
      .orderBy(
        sql`CASE WHEN ${w.runnerId} IS NULL THEN 1 ELSE 0 END`,
        sql`${r.createdAt} DESC`,
        sql`${r.id} DESC`,
      )
      .limit(1),
  );
}

export function* latestModelCatalogSteps(q: Q, runnerId: string, agent: string) {
  const { agentModelCatalog: c } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ resultJson: jsonText(q, c.resultJson) })
      .from(c)
      .where(and(eq(c.runnerId, runnerId), eq(c.agent, agent), eq(c.model, "")))
      .orderBy(desc(c.updatedAt))
      .limit(1),
  );
  return row?.resultJson ?? null;
}

export function* runnerUsageListSteps(
  q: Q,
  input: { workspaceId: string; all: boolean; userId: string; runnerId: string },
) {
  const {
    runnerExecutionUsage: u,
    runner: r,
    runnerCommandAccount: c,
    agentAccount: a,
    workItem: w,
  } = q.t;
  return yield* q.all(
    q.orm
      .select({
        commandId: u.commandId,
        runnerId: u.runnerId,
        runnerName: r.name,
        ownerUserId: u.ownerUserId,
        itemId: u.itemId,
        runId: u.runId,
        agent: u.agent,
        model: u.model,
        resolvedModel: u.resolvedModel,
        role: u.role,
        purpose: u.purpose,
        startedAt: u.startedAt,
        endedAt: u.endedAt,
        outcome: u.outcome,
        outputBytes: u.outputBytes,
        placementReason: u.placementReason,
        accountPolicyRevision: u.accountPolicyRevision,
        accountFallback: u.accountFallback,
        accountLabel: a.label,
        accountNamed: c.named,
        identifier: w.linearIdentifier,
        title: w.title,
      })
      .from(u)
      .innerJoin(r, eq(r.id, u.runnerId))
      .leftJoin(c, eq(c.commandId, u.commandId))
      .leftJoin(a, eq(a.id, c.accountId))
      .leftJoin(w, eq(w.id, u.itemId))
      .where(
        and(
          eq(r.workspaceId, input.workspaceId),
          input.all ? undefined : eq(u.ownerUserId, input.userId),
          input.runnerId === "" ? undefined : eq(u.runnerId, input.runnerId),
        ),
      )
      .orderBy(desc(u.startedAt), desc(u.commandId))
      .limit(100),
  );
}

export function* runnerSharingSteps(q: Q, runnerId: string) {
  const { runnerPolicy: p } = q.t;
  return yield* q.one(q.orm.select({ sharing: p.sharing }).from(p).where(eq(p.runnerId, runnerId)));
}

export function* runnerAgentPoliciesSteps(q: Q, runnerId: string) {
  const { runnerAgentPolicy: p } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        agent: p.agent,
        ready: p.ready,
        authExpired: p.authExpired,
        quotaState: p.quotaState,
        resetsAt: p.resetsAt,
        cooldownUntil: p.cooldownUntil,
        resolvedModel: p.resolvedModel,
        extraUsage: p.extraUsage,
      })
      .from(p)
      .where(eq(p.runnerId, runnerId))
      .orderBy(asc(p.agent)),
  );
  return rows.map((row) => ({ ...row, extraUsage: row.extraUsage === 1 }));
}

export function* bindingReadinessRowSteps(q: Q, bindingId: string) {
  const { agentAccountBinding: b, agentAccount: a, runner: r, runnerAgentPolicy: p } = q.t;
  return yield* q.one(
    q.orm
      .select({
        runnerId: b.runnerId,
        accountId: b.accountId,
        bindingRemoved: b.removedAt,
        accountRemoved: a.removedAt,
        enabled: a.enabled,
        concurrency: a.concurrency,
        status: r.status,
        revokedAt: r.revokedAt,
        lastSeenAt: r.lastSeenAt,
        legacy: b.legacy,
        authExpired: p.authExpired,
      })
      .from(b)
      .innerJoin(a, eq(a.id, b.accountId))
      .innerJoin(r, eq(r.id, b.runnerId))
      .leftJoin(p, and(eq(p.runnerId, b.runnerId), eq(p.agent, b.agent)))
      .where(eq(b.id, bindingId)),
  );
}
