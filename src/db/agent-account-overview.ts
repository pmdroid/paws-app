import { providerUsageSteps } from "./account-provider-usage";
import { agentAuthFailureSteps } from "./agent-auth";
import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
import { type RunnerCodingAgent } from "../runner-protocol";
import { AgentAccountError, listAgentBindingsSteps } from "./agent-accounts";
import { enqueueJobSteps } from "./jobs";
import { wakeRunnerSlotWaitsSteps } from "./runner-capacity";
import type { Q, Steps } from "./db";
import type { RunnerAgentLimit } from "./runners";

export type AgentAccountOverview = {
  id: string;
  agent: RunnerCodingAgent;
  label: string;
  position: number;
  extraUsage: boolean;
  enabled: boolean;
  signingIn: boolean;
  credential: { refreshedAt: number; runner: string | null } | null;
  usage: {
    limits: RunnerAgentLimit[];
    observedAt: number;
    stale?: boolean;
    unavailable?: string;
  } | null;
};

export function* agentAccountOverviewSteps(
  q: Q,
  workspaceId: string,
  now: number,
  ownerUserId?: string,
): Steps<AgentAccountOverview[]> {
  const { agentAccount: a, agentAccountCredential: c } = q.t;
  const { agentAccountBinding: b, runner, runnerLogin } = q.t;
  const accounts = yield* q.all(
    q.orm
      .select({
        id: a.id,
        agent: a.agent,
        label: a.label,
        position: a.position,
        extraUsage: a.extraUsage,
        enabled: a.enabled,
        signedOut: c.ciphertext,
        refreshedAt: c.updatedAt,
        refreshedBy: c.runnerId,
      })
      .from(a)
      .leftJoin(c, eq(c.accountId, a.id))
      .where(
        and(
          eq(a.workspaceId, workspaceId),
          isNull(a.removedAt),
          ownerUserId === undefined ? undefined : eq(a.ownerUserId, ownerUserId),
        ),
      )
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
  const providerUsage = new Map<string, NonNullable<AgentAccountOverview["usage"]>>();
  for (const id of ids) {
    const stored = yield* providerUsageSteps(q, id);
    if (stored?.limitsJson) providerUsage.set(id, JSON.parse(stored.limitsJson));
  }
  const expired = new Set<string>();
  for (const row of accounts) if (yield* agentAuthFailureSteps(q, row.id)) expired.add(row.id);
  return accounts.map((row) => ({
    id: row.id,
    agent: row.agent as RunnerCodingAgent,
    label: row.label,
    position: row.position,
    extraUsage: row.extraUsage === 1,
    enabled: row.enabled === 1,
    signingIn: signingIn.has(row.id),
    credential:
      row.refreshedAt === null || row.signedOut === "" || expired.has(row.id)
        ? null
        : {
            refreshedAt: row.refreshedAt,
            runner: row.refreshedBy === null ? null : (runners.get(row.refreshedBy) ?? null),
          },
    usage: providerUsage.get(row.id) ?? null,
  }));
}

function* liveCentralAccountSteps(q: Q, workspaceId: string, accountId: string) {
  const { agentAccount: a } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ id: a.id, agent: a.agent, ownerUserId: a.ownerUserId })
      .from(a)
      .where(and(eq(a.id, accountId), eq(a.workspaceId, workspaceId), isNull(a.removedAt))),
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
        and(eq(a.workspaceId, input.workspaceId), eq(a.agent, input.agent), isNull(a.removedAt)),
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
): Steps<boolean> {
  const { agentAccount: a, agentAccountHealth: h } = q.t;
  const row = yield* liveCentralAccountSteps(q, input.workspaceId, input.accountId);
  yield* q.exec(
    q.orm
      .update(a)
      .set({ extraUsage: input.extraUsage ? 1 : 0, updatedAt: input.now })
      .where(eq(a.id, row.id)),
  );
  if (!input.extraUsage) return false;
  const cleared = yield* q.all(
    q.orm
      .update(h)
      .set({ nextCheckAt: input.now, updatedAt: input.now })
      .where(and(eq(h.kind, "quota"), eq(h.scopeId, row.id), eq(h.state, "exhausted")))
      .returning({ scopeId: h.scopeId }),
  );
  if (cleared.length === 0) return false;
  yield* enqueueJobSteps(q, {
    queue: "agent.usage.after-run",
    payload: { accountId: row.id },
    now: input.now,
  });
  for (const binding of yield* listAgentBindingsSteps(q, input.workspaceId, row.id))
    if (binding.removedAt === null) yield* wakeRunnerSlotWaitsSteps(q, binding.runnerId, input.now);
  return true;
}

export function* signOutAgentAccountSteps(
  q: Q,
  input: { workspaceId: string; accountId: string; now: number },
): Steps<void> {
  const row = yield* liveCentralAccountSteps(q, input.workspaceId, input.accountId);
  const { agentAccountCredential: c } = q.t;
  const stored = yield* q.one(
    q.orm.select({ version: c.version }).from(c).where(eq(c.accountId, row.id)),
  );
  const signedOut = {
    agent: row.agent,
    ciphertext: "",
    version: (stored?.version ?? 0) + 1,
    updatedAt: input.now,
    runnerId: null,
  };
  yield* q.exec(
    q.orm
      .insert(c)
      .values({ accountId: row.id, ...signedOut })
      .onConflictDoUpdate({ target: c.accountId, set: signedOut }),
  );
}
