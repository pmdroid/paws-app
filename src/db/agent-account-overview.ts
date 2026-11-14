import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
import {
  AGENT_CREDENTIAL_RUNNER_VERSION,
  runnerReleaseAtLeast,
  type RunnerCodingAgent,
} from "../runner-protocol";
import {
  AgentAccountError,
  bindAgentAccountSteps,
  liveAccountBindingSteps,
} from "./agent-accounts";
import type { Q, Steps } from "./db";
import type { RunnerAgentLimit } from "./runners";

export type AgentAccountOverview = {
  id: string;
  agent: RunnerCodingAgent;
  label: string;
  position: number;
  extraUsage: boolean;
  signingIn: boolean;
  credential: { refreshedAt: number; runner: string | null } | null;
  usage: { limits: RunnerAgentLimit[]; observedAt: number } | null;
  lease: {
    runner: string;
    runId: string;
    startedAt: number | null;
    issue: { itemId: string; identifier: string } | null;
  } | null;
};

const ONLINE_MS = 60_000;

export function* agentAccountOverviewSteps(
  q: Q,
  workspaceId: string,
  now: number,
): Steps<AgentAccountOverview[]> {
  const { agentAccount: a, agentAccountCredential: c, agentAccountUsage: u } = q.t;
  const { agentAccountLease: l, agentAccountBinding: b, runner, runnerLogin, run, workItem } = q.t;
  const accounts = yield* q.all(
    q.orm
      .select({
        id: a.id,
        agent: a.agent,
        label: a.label,
        position: a.position,
        extraUsage: a.extraUsage,
        refreshedAt: c.updatedAt,
        refreshedBy: c.runnerId,
        limits: u.limitsJson,
        observedAt: u.observedAt,
      })
      .from(a)
      .leftJoin(c, eq(c.accountId, a.id))
      .leftJoin(u, eq(u.accountId, a.id))
      .where(and(eq(a.workspaceId, workspaceId), eq(a.legacy, 0), isNull(a.removedAt)))
      .orderBy(asc(a.agent), asc(a.position), asc(a.createdAt), asc(a.id)),
  );
  const ids = accounts.map((row) => row.id);
  if (ids.length === 0) return [];
  const runners = new Map(
    (yield* q.all(
      q.orm
        .select({ id: runner.id, name: runner.name })
        .from(runner)
        .where(eq(runner.workspaceId, workspaceId)),
    )).map((row) => [row.id, row.name]),
  );
  const leases = new Map(
    (yield* q.all(
      q.orm
        .select({
          accountId: l.accountId,
          runnerId: l.runnerId,
          runId: l.runId,
          startedAt: run.createdAt,
          itemId: workItem.id,
          identifier: workItem.linearIdentifier,
        })
        .from(l)
        .leftJoin(run, eq(run.id, l.runId))
        .leftJoin(workItem, eq(workItem.id, run.itemId))
        .where(and(inArray(l.accountId, ids), gt(l.expiresAt, now))),
    )).map((row) => [row.accountId, row]),
  );
  const signingIn = new Set(
    (yield* q.all(
      q.orm
        .select({ accountId: b.accountId })
        .from(runnerLogin)
        .innerJoin(b, eq(b.id, runnerLogin.bindingId))
        .where(
          and(
            inArray(b.accountId, ids),
            inArray(runnerLogin.state, ["starting", "waiting"]),
            gt(runnerLogin.expiresAt, now),
          ),
        ),
    )).map((row) => row.accountId),
  );
  return accounts.map((row) => {
    const lease = leases.get(row.id);
    return {
      id: row.id,
      agent: row.agent as RunnerCodingAgent,
      label: row.label,
      position: row.position,
      extraUsage: row.extraUsage === 1,
      signingIn: signingIn.has(row.id),
      credential:
        row.refreshedAt === null
          ? null
          : {
              refreshedAt: row.refreshedAt,
              runner: row.refreshedBy === null ? null : (runners.get(row.refreshedBy) ?? null),
            },
      usage:
        row.limits === null || row.observedAt === null
          ? null
          : { limits: JSON.parse(row.limits) as RunnerAgentLimit[], observedAt: row.observedAt },
      lease: lease
        ? {
            runner: runners.get(lease.runnerId) ?? lease.runnerId,
            runId: lease.runId,
            startedAt: lease.startedAt,
            issue:
              lease.itemId && lease.identifier
                ? { itemId: lease.itemId, identifier: lease.identifier }
                : null,
          }
        : null,
    };
  });
}

function* liveCentralAccountSteps(q: Q, workspaceId: string, accountId: string) {
  const { agentAccount: a } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ id: a.id, agent: a.agent })
      .from(a)
      .where(
        and(
          eq(a.id, accountId),
          eq(a.workspaceId, workspaceId),
          eq(a.legacy, 0),
          isNull(a.removedAt),
        ),
      ),
  );
  if (!row) throw new AgentAccountError("not_found", "Agent account is unavailable");
  return row;
}

export function* orderAgentAccountsSteps(
  q: Q,
  input: { workspaceId: string; agent: RunnerCodingAgent; ids: string[]; now: number },
): Steps<void> {
  const { agentAccount: a } = q.t;
  const current = yield* q.all(
    q.orm
      .select({ id: a.id })
      .from(a)
      .where(
        and(
          eq(a.workspaceId, input.workspaceId),
          eq(a.agent, input.agent),
          eq(a.legacy, 0),
          isNull(a.removedAt),
        ),
      ),
  );
  const known = new Set(current.map((row) => row.id));
  if (
    input.ids.length !== known.size ||
    new Set(input.ids).size !== known.size ||
    input.ids.some((id) => !known.has(id))
  )
    throw new AgentAccountError("invalid", "The order must list each account once");
  for (const [index, id] of input.ids.entries())
    yield* q.exec(
      q.orm
        .update(a)
        .set({ position: index + 1, updatedAt: input.now })
        .where(eq(a.id, id)),
    );
}

export function* setAgentAccountExtraUsageSteps(
  q: Q,
  input: { workspaceId: string; accountId: string; extraUsage: boolean; now: number },
): Steps<void> {
  const { agentAccount: a } = q.t;
  const row = yield* liveCentralAccountSteps(q, input.workspaceId, input.accountId);
  yield* q.exec(
    q.orm
      .update(a)
      .set({ extraUsage: input.extraUsage ? 1 : 0, updatedAt: input.now })
      .where(eq(a.id, row.id)),
  );
}

export function* signOutAgentAccountSteps(
  q: Q,
  input: { workspaceId: string; accountId: string },
): Steps<void> {
  const row = yield* liveCentralAccountSteps(q, input.workspaceId, input.accountId);
  const { agentAccountCredential: c } = q.t;
  yield* q.exec(q.orm.delete(c).where(eq(c.accountId, row.id)));
}

export function* centralSignInTargetSteps(
  q: Q,
  input: { workspaceId: string; accountId: string; now: number },
): Steps<{ runnerId: string; bindingId: string; agent: RunnerCodingAgent }> {
  const account = yield* liveCentralAccountSteps(q, input.workspaceId, input.accountId);
  const { runner, runnerHostStatus: h } = q.t;
  const online = yield* q.all(
    q.orm
      .select({ id: runner.id, version: h.runnerVersion })
      .from(runner)
      .innerJoin(h, eq(h.runnerId, runner.id))
      .where(
        and(
          eq(runner.workspaceId, input.workspaceId),
          eq(runner.status, "active"),
          isNull(runner.revokedAt),
          gt(runner.lastSeenAt, input.now - ONLINE_MS),
        ),
      )
      .orderBy(asc(runner.name), asc(runner.id)),
  );
  const target = online.find((row) =>
    runnerReleaseAtLeast(row.version, AGENT_CREDENTIAL_RUNNER_VERSION),
  );
  if (!target)
    throw new AgentAccountError(
      "runner_unsupported",
      "No online runner supports central sign-ins. Start or update a runner, then try again.",
    );
  const agent = account.agent as RunnerCodingAgent;
  const bound = yield* liveAccountBindingSteps(q, target.id, account.id);
  if (bound) return { runnerId: target.id, bindingId: bound.id, agent };
  const binding = yield* bindAgentAccountSteps(q, {
    workspaceId: input.workspaceId,
    accountId: account.id,
    runnerId: target.id,
    now: input.now,
  });
  return { runnerId: target.id, bindingId: binding.id, agent };
}
