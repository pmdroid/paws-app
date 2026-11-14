import { and, count, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Q, Steps } from "./db";
import { jsonText } from "./json-text";
import { workspaceMemberUsableWhere } from "./workspace";
import { setRunnerAgentSignedInSteps } from "./runner-work";
import { noteRunnerSeenSteps } from "./runners";

const HEALTH_KINDS = ["probe", "login_check"];

export function* healthCommandEnvelopeSteps(
  q: Q,
  commandId: string,
  runnerId: string,
): Steps<string | null> {
  const { runnerCommand: c } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ envelope: jsonText(q, c.envelope) })
      .from(c)
      .where(and(eq(c.id, commandId), eq(c.runnerId, runnerId), inArray(c.kind, HEALTH_KINDS))),
  );
  return row?.envelope ?? null;
}

export function* pendingHealthChecksSteps(q: Q, runnerId: string, at: number): Steps<number> {
  const { runnerCommand: c, runnerHealthResult: h } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ count: count() })
      .from(c)
      .leftJoin(h, eq(h.commandId, c.id))
      .where(
        and(
          eq(c.runnerId, runnerId),
          inArray(c.kind, HEALTH_KINDS),
          gt(c.expiresAt, at),
          isNull(h.commandId),
        ),
      ),
  );
  return Number(row?.count ?? 0);
}

export function* healthCheckHistorySteps(
  q: Q,
  runnerId: string,
  kinds: readonly string[],
  limit: number,
) {
  const { runnerCommand: c, runnerHealthResult: h } = q.t;
  return yield* q.all(
    q.orm
      .select({
        id: c.id,
        envelope: jsonText(q, c.envelope),
        expiresAt: c.expiresAt,
        receivedAt: h.receivedAt,
        resultJson: h.resultJson,
      })
      .from(c)
      .leftJoin(h, eq(h.commandId, c.id))
      .where(and(eq(c.runnerId, runnerId), inArray(c.kind, [...kinds])))
      .orderBy(desc(c.ordinal))
      .limit(limit),
  );
}

export function* seenMemberRunnersSteps(q: Q, seenAfter: number) {
  const { runner, workspaceMember: owner } = q.t;
  return yield* q.all(
    q.orm
      .select({ id: runner.id, workspaceId: runner.workspaceId })
      .from(runner)
      .innerJoin(
        owner,
        and(eq(owner.workspaceId, runner.workspaceId), eq(owner.userId, runner.ownerUserId)),
      )
      .where(
        and(
          eq(runner.status, "active"),
          isNull(runner.revokedAt),
          workspaceMemberUsableWhere(owner),
          gt(runner.lastSeenAt, seenAfter),
        ),
      )
      .orderBy(runner.id),
  );
}

export function* runnerAgentPolicyRowSteps(q: Q, runnerId: string, agent: string) {
  const { runnerAgentPolicy: p } = q.t;
  return yield* q.one(
    q.orm
      .select({
        extraUsage: p.extraUsage,
        quotaState: p.quotaState,
        resetsAt: p.resetsAt,
        cooldownUntil: p.cooldownUntil,
      })
      .from(p)
      .where(and(eq(p.runnerId, runnerId), eq(p.agent, agent))),
  );
}

export function* healthResultJsonSteps(
  q: Q,
  commandId: string,
  runnerId?: string,
): Steps<string | null> {
  const { runnerHealthResult: h } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ resultJson: h.resultJson })
      .from(h)
      .where(
        and(
          eq(h.commandId, commandId),
          runnerId === undefined ? undefined : eq(h.runnerId, runnerId),
        ),
      ),
  );
  return row?.resultJson ?? null;
}

export function* insertHealthResultSteps(
  q: Q,
  commandId: string,
  runnerId: string,
  resultJson: string,
  at: number,
) {
  yield* q.exec(
    q.orm
      .insert(q.t.runnerHealthResult)
      .values({ commandId, runnerId, resultJson, receivedAt: at }),
  );
}

export function* setLegacyAgentReadySteps(
  q: Q,
  runnerId: string,
  agent: string,
  ready: boolean,
  now: number,
) {
  yield* setRunnerAgentSignedInSteps(q, runnerId, agent, ready, now);
}

export function* setLegacyAgentQuotaSteps(
  q: Q,
  runnerId: string,
  agent: string,
  quota: { state: string; resetsAt: number | null; cooldownUntil: number },
) {
  const { runnerAgentPolicy: p } = q.t;
  yield* q.exec(
    q.orm
      .update(p)
      .set({
        quotaState: quota.state,
        resetsAt: quota.resetsAt,
        cooldownUntil: quota.cooldownUntil,
      })
      .where(and(eq(p.runnerId, runnerId), eq(p.agent, agent))),
  );
}

export function* touchRunnerSeenSteps(q: Q, runnerId: string, at: number) {
  yield* noteRunnerSeenSteps(q, runnerId, at);
}

export const HEALTH_COMMAND_KINDS: readonly string[] = HEALTH_KINDS;
export const LOGIN_CHECK_KINDS: readonly string[] = ["login_check"];

const RUNNER_HEALTH_RESULTS_KEPT = 50;

/**
 * Deletes up to `limit` health results beyond each runner's latest 50 whose command expired
 * before `cutoff` and no unfinished model probe waits on, and returns how many it deleted.
 */
export function* pruneRunnerHealthResultsSteps(q: Q, cutoff: number, limit: number): Steps<number> {
  const { runnerHealthResult: h } = q.t;
  const prunable = sql`
    SELECT ranked.command_id FROM (
      SELECT r.command_id, ROW_NUMBER() OVER (
        PARTITION BY r.runner_id ORDER BY r.received_at DESC, r.command_id DESC) AS place
      FROM runner_health_result r) ranked
    JOIN runner_command c ON c.id=ranked.command_id
    WHERE ranked.place>${RUNNER_HEALTH_RESULTS_KEPT} AND c.expires_at<${cutoff}
      AND NOT EXISTS(SELECT 1 FROM agent_model_probe p
        WHERE p.command_id=ranked.command_id AND p.finished_at IS NULL)
    LIMIT ${limit}`;
  const deleted = yield* q.all(
    q.orm
      .delete(h)
      .where(sql`${h.commandId} IN (${prunable})`)
      .returning({ commandId: h.commandId }),
  );
  return deleted.length;
}
