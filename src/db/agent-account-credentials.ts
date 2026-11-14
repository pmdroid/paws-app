import { and, asc, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { RunnerCodingAgent } from "../runner-protocol";
import { AgentAccountError } from "./agent-accounts";
import { type Q, type Steps } from "./db";
import type { RunnerAgentLimit } from "./runners";

export const AGENT_ACCOUNT_LEASE_GRACE_MS = 10 * 60_000;

export type AgentAccountLease = {
  accountId: string;
  runnerId: string;
  runId: string;
  expiresAt: number;
};

type LeaseHolder = { accountId: string; runnerId: string; runId: string };

export function* agentAccountLeaseSteps(q: Q, accountId: string): Steps<AgentAccountLease | null> {
  const { agentAccountLease: lease } = q.t;
  const row = yield* q.one(q.orm.select().from(lease).where(eq(lease.accountId, accountId)));
  return row ?? null;
}

export function* takeAgentAccountLeaseSteps(
  q: Q,
  input: LeaseHolder & { until: number; now: number },
): Steps<boolean> {
  const { agentAccountLease: lease } = q.t;
  const expiresAt = input.until + AGENT_ACCOUNT_LEASE_GRACE_MS;
  const rows = yield* q.all(
    q.orm
      .insert(lease)
      .values({
        accountId: input.accountId,
        runnerId: input.runnerId,
        runId: input.runId,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: lease.accountId,
        set: { runnerId: input.runnerId, runId: input.runId, expiresAt },
        setWhere: or(
          lte(lease.expiresAt, input.now),
          and(eq(lease.runnerId, input.runnerId), eq(lease.runId, input.runId)),
        ),
      })
      .returning({ accountId: lease.accountId }),
  );
  return rows.length > 0;
}

export function* renewAgentAccountLeaseSteps(
  q: Q,
  input: LeaseHolder & { until: number },
): Steps<boolean> {
  const { agentAccountLease: lease } = q.t;
  const rows = yield* q.all(
    q.orm
      .update(lease)
      .set({ expiresAt: input.until + AGENT_ACCOUNT_LEASE_GRACE_MS })
      .where(holder(q, input))
      .returning({ accountId: lease.accountId }),
  );
  return rows.length > 0;
}

export function* releaseAgentAccountLeaseSteps(q: Q, input: LeaseHolder): Steps<void> {
  yield* q.exec(q.orm.delete(q.t.agentAccountLease).where(holder(q, input)));
}

function holder(q: Q, input: LeaseHolder) {
  const { agentAccountLease: lease } = q.t;
  return and(
    eq(lease.accountId, input.accountId),
    eq(lease.runnerId, input.runnerId),
    eq(lease.runId, input.runId),
  );
}

export type AgentCredentialCiphertext = {
  agent: RunnerCodingAgent;
  ciphertext: string;
  version: number;
  updatedAt: number;
  runnerId: string | null;
};

export function* agentCredentialCiphertextSteps(
  q: Q,
  accountId: string,
): Steps<AgentCredentialCiphertext | null> {
  const { agentAccountCredential: c } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        agent: c.agent,
        ciphertext: c.ciphertext,
        version: c.version,
        updatedAt: c.updatedAt,
        runnerId: c.runnerId,
      })
      .from(c)
      .where(eq(c.accountId, accountId)),
  );
  return row ? { ...row, agent: row.agent as RunnerCodingAgent } : null;
}

export type AgentCredentialWrite = "written" | "not_holder" | "stale_version";

export function* writeAgentCredentialCiphertextSteps(
  q: Q,
  input: { accountId: string; runnerId: string; version: number; ciphertext: string; now: number },
): Steps<AgentCredentialWrite> {
  const { agentAccount, agentAccountCredential: c } = q.t;
  const account = yield* q.one(
    q.orm
      .select({ agent: agentAccount.agent })
      .from(agentAccount)
      .where(eq(agentAccount.id, input.accountId)),
  );
  if (!account) throw new AgentAccountError("not_found", "Agent account is unavailable");
  const lease = yield* agentAccountLeaseSteps(q, input.accountId);
  if (lease && lease.expiresAt > input.now && lease.runnerId !== input.runnerId)
    return "not_holder";
  const stored = yield* agentCredentialCiphertextSteps(q, input.accountId);
  if ((stored?.version ?? 0) + 1 !== input.version) return "stale_version";
  const written = {
    agent: account.agent,
    ciphertext: input.ciphertext,
    version: input.version,
    updatedAt: input.now,
    runnerId: input.runnerId,
  };
  const rows = yield* q.all(
    q.orm
      .insert(c)
      .values({ accountId: input.accountId, ...written })
      .onConflictDoUpdate({
        target: c.accountId,
        set: written,
        setWhere: eq(c.version, input.version - 1),
      })
      .returning({ accountId: c.accountId }),
  );
  return rows.length > 0 ? "written" : "stale_version";
}

export function* recordAgentAccountUsageSteps(
  q: Q,
  usage: { accountId: string; runnerId: string; limits: RunnerAgentLimit[]; observedAt: number },
): Steps<void> {
  const { agentAccountUsage: stored } = q.t;
  const set = {
    runnerId: usage.runnerId,
    limitsJson: JSON.stringify(usage.limits),
    observedAt: usage.observedAt,
  };
  yield* q.exec(
    q.orm
      .insert(stored)
      .values({ accountId: usage.accountId, ...set })
      .onConflictDoUpdate({
        target: stored.accountId,
        set,
        setWhere: sql`excluded.observed_at>=${stored.observedAt}`,
      }),
  );
}

export type CentralAgentAccount = {
  id: string;
  concurrency: number | null;
  extraUsage: boolean;
  limits: RunnerAgentLimit[];
};

export function* centralAgentAccountsSteps(
  q: Q,
  workspaceId: string,
  agent: RunnerCodingAgent,
): Steps<CentralAgentAccount[]> {
  const { agentAccount: a, agentAccountUsage: u, agentAccountCredential: c } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        id: a.id,
        concurrency: a.concurrency,
        extraUsage: a.extraUsage,
        limits: u.limitsJson,
      })
      .from(a)
      .leftJoin(u, eq(u.accountId, a.id))
      .leftJoin(c, eq(c.accountId, a.id))
      .where(
        and(
          or(isNull(c.ciphertext), ne(c.ciphertext, "")),
          eq(a.workspaceId, workspaceId),
          eq(a.agent, agent),
          eq(a.legacy, 0),
          eq(a.enabled, 1),
          isNull(a.removedAt),
        ),
      )
      .orderBy(asc(a.position), asc(a.createdAt), asc(a.id)),
  );
  return rows.map((row) => ({
    id: row.id,
    concurrency: row.concurrency,
    extraUsage: row.extraUsage === 1,
    limits: row.limits === null ? [] : (JSON.parse(row.limits) as RunnerAgentLimit[]),
  }));
}
