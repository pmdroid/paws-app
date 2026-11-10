import { and, eq, gt, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import type { Q, Steps } from "./db";
import { jsonText } from "./json-text";
import { workspaceMemberUsableWhere } from "./workspace";

export function* runnerNameSteps(q: Q, runnerId: string): Steps<string | null> {
  const { runner } = q.t;
  const row = yield* q.one(
    q.orm.select({ name: runner.name }).from(runner).where(eq(runner.id, runnerId)),
  );
  return row?.name ?? null;
}

export function* anyActiveRunnerSteps(q: Q): Steps<boolean> {
  const { runner } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(runner)
      .where(and(eq(runner.status, "active"), isNull(runner.revokedAt)))
      .limit(1),
  );
  return row !== undefined;
}

export function* itemStartedRunnerWorkSteps(q: Q, itemId: string): Steps<boolean> {
  const { runnerExecutionUsage: usage } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(usage)
      .where(and(eq(usage.itemId, itemId), eq(usage.purpose, "work")))
      .limit(1),
  );
  return row !== undefined;
}

export function* runnerWorkHostsSteps(q: Q, runIds: readonly string[]) {
  const { runnerWork: work } = q.t;
  return yield* q.all(
    q.orm
      .select({ runId: work.runId, runnerId: work.runnerId })
      .from(work)
      .where(inArray(work.runId, [...runIds])),
  );
}

export function* onlineMemberRunnersSteps(q: Q, seenAfter: number) {
  const { runner, workspaceMember: member } = q.t;
  return yield* q.all(
    q.orm
      .select({ id: runner.id, workspaceId: runner.workspaceId })
      .from(runner)
      .innerJoin(
        member,
        and(eq(member.workspaceId, runner.workspaceId), eq(member.userId, runner.ownerUserId)),
      )
      .where(
        and(
          eq(runner.status, "active"),
          isNull(runner.revokedAt),
          workspaceMemberUsableWhere(member),
          gt(runner.lastSeenAt, seenAfter),
        ),
      )
      .orderBy(sql`${runner.lastSeenAt} DESC`, runner.id),
  );
}

export function* runnerOnlineSteps(q: Q, runnerId: string, seenAfter: number): Steps<boolean> {
  const { runner } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(runner)
      .where(
        and(
          eq(runner.id, runnerId),
          eq(runner.status, "active"),
          isNull(runner.revokedAt),
          gt(runner.lastSeenAt, seenAfter),
        ),
      ),
  );
  return row !== undefined;
}

export function* leasedRunnerWorkCommandSteps(q: Q, runId: string, leaseCutoff: number) {
  const { runnerWork: w, runnerCommand: c, runnerResult: r } = q.t;
  return yield* q.one(
    q.orm
      .select({
        runnerId: w.runnerId,
        workspaceId: w.workspaceId,
        envelope: jsonText(q, c.envelope),
        cursor: w.consumedSequence,
        generation: w.generation,
      })
      .from(w)
      .innerJoin(c, eq(c.id, w.commandId))
      .where(
        and(
          eq(w.runId, runId),
          isNull(w.endedAt),
          sql`(${w.leaseUntil} > ${leaseCutoff} OR EXISTS (SELECT 1 FROM ${r}
            WHERE ${r.runId} = ${w.runId} AND ${r.generation} = ${w.generation}
            AND ${r.commandId} = ${w.commandId}))`,
        ),
      ),
  );
}

export function* runnerWorkGenerationSteps(q: Q, runId: string): Steps<number | null> {
  const { runnerWork: work } = q.t;
  const row = yield* q.one(
    q.orm.select({ generation: work.generation }).from(work).where(eq(work.runId, runId)),
  );
  return row?.generation ?? null;
}

export function* runnerWorkLivenessSteps(q: Q, runId: string, generation: number) {
  const { runnerWork: work } = q.t;
  return yield* q.one(
    q.orm
      .select({ confirmedAt: work.confirmedAt, lostAt: work.lostAt })
      .from(work)
      .where(and(eq(work.runId, runId), eq(work.generation, generation))),
  );
}

export function* runnerLastSeenSteps(q: Q, runnerId: string): Steps<number | null> {
  const { runner } = q.t;
  const row = yield* q.one(
    q.orm.select({ lastSeen: runner.lastSeenAt }).from(runner).where(eq(runner.id, runnerId)),
  );
  return row?.lastSeen ?? null;
}

export function* runnerWorkUnreachableSteps(
  q: Q,
  runId: string,
  generation: number,
  leaseCutoff: number,
  seenBy: number,
): Steps<boolean> {
  const { runnerWork: w, runner } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(w)
      .innerJoin(runner, eq(runner.id, w.runnerId))
      .where(
        and(
          eq(w.runId, runId),
          eq(w.generation, generation),
          isNull(w.endedAt),
          gt(w.leaseUntil, leaseCutoff),
          lte(sql`COALESCE(${runner.lastSeenAt}, 0)`, seenBy),
        ),
      ),
  );
  return row !== undefined;
}

export function* setRunnerWorkCursorSteps(q: Q, runId: string, generation: number, cursor: number) {
  const { runnerWork: work } = q.t;
  yield* q.exec(
    q.orm
      .update(work)
      .set({ consumedSequence: cursor })
      .where(and(eq(work.runId, runId), eq(work.generation, generation))),
  );
}

export function* endLostRunnerWorkSteps(q: Q, runId: string, generation: number, at: number) {
  const { runnerWork: work, runnerWorkGrant: grant } = q.t;
  yield* q.exec(
    q.orm
      .update(work)
      .set({ endedAt: at, lostAt: at })
      .where(and(eq(work.runId, runId), eq(work.generation, generation), isNull(work.endedAt))),
  );
  yield* q.exec(q.orm.delete(grant).where(eq(grant.runId, runId)));
}

export function* runWaitsOnQuestionSteps(q: Q, runId: string): Steps<boolean> {
  const { question } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ status: question.status, cancelledAt: question.cancelledAt })
      .from(question)
      .where(eq(question.runId, runId)),
  );
  return (
    rows.length === 0 ||
    rows.some(
      (row) => (row.status === "open" || row.status === "queued") && row.cancelledAt === null,
    )
  );
}

export function* lastRunResultSteps(q: Q, itemId: string) {
  const { runnerResult: result, runnerCommand: command, run } = q.t;
  return yield* q.one(
    q.orm
      .select({
        runnerId: command.runnerId,
        envelope: jsonText(q, command.envelope),
        payload: jsonText(q, result.payload),
      })
      .from(result)
      .innerJoin(command, eq(command.id, result.commandId))
      .innerJoin(run, eq(run.id, result.runId))
      .where(and(eq(run.itemId, itemId), eq(command.kind, "run")))
      .orderBy(sql`${result.receivedAt} DESC`, sql`${result.generation} DESC`)
      .limit(1),
  );
}

export function* usageLimitResetSteps(
  q: Q,
  agent: string,
  sessionId: string | null,
  now: number,
): Steps<number | null> {
  if (sessionId === null) return null;
  const { runner, runnerAgentPolicy: policy, agentAccountHealth: health } = q.t;
  const { workspace, linearSession: session } = q.t;
  const sessionWorkspaces = q.orm
    .select({ id: workspace.id })
    .from(workspace)
    .innerJoin(session, eq(session.organizationId, workspace.linearOrganizationId))
    .where(eq(session.sessionId, sessionId));
  const inScope = and(
    eq(runner.status, "active"),
    isNull(runner.revokedAt),
    inArray(runner.workspaceId, sessionWorkspaces),
  );
  const cooldowns = yield* q.all(
    q.orm
      .select({ at: policy.cooldownUntil })
      .from(policy)
      .innerJoin(runner, eq(runner.id, policy.runnerId))
      .where(and(eq(policy.agent, agent), gt(policy.cooldownUntil, now), inScope)),
  );
  const checks = yield* q.all(
    q.orm
      .select({ at: health.nextCheckAt })
      .from(health)
      .innerJoin(runner, eq(runner.id, health.runnerId))
      .where(
        and(
          eq(health.agent, agent),
          inArray(health.state, ["exhausted", "restricted"]),
          ne(health.scope, "binding"),
          gt(health.nextCheckAt, now),
          inScope,
        ),
      ),
  );
  const times = [...cooldowns, ...checks]
    .map((row) => row.at)
    .filter((at): at is number => at !== null);
  return times.length ? Math.min(...times) : null;
}
