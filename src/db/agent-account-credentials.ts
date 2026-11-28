import { providerUsageSteps } from "./account-provider-usage";
import { enqueueRunnerSetupChecksSteps } from "./runner-setup-hold";
import { agentAuthFailureSteps } from "./agent-auth";
import { and, asc, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { CENTRAL_CREDENTIAL_AGENTS, type RunnerCodingAgent } from "../runner-protocol";
import { AgentAccountError, listAgentBindingsSteps } from "./agent-accounts";
import { readSecretSteps, writeSecretSteps } from "./credentials";
import { type Q, type Steps } from "./db";
import type { RunnerAgentLimit } from "./runners";

export type AgentCredentialCiphertext = {
  agent: RunnerCodingAgent;
  ciphertext: string;
  version: number;
  updatedAt: number;
  runnerId: string | null;
};

export function agentCredentialSecretName(accountId: string): string {
  return `agent-account-${accountId}`;
}

export function agentCredentialSecretJoin(q: Q) {
  const { agentAccountCredential: c, secret: s } = q.t;
  return eq(s.name, sql`'agent-account-' || ${c.accountId}`);
}

export function* agentCredentialCiphertextSteps(
  q: Q,
  accountId: string,
): Steps<AgentCredentialCiphertext | null> {
  const { agentAccountCredential: c, secret: s } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        agent: c.agent,
        ciphertext: s.ciphertext,
        version: c.version,
        updatedAt: c.updatedAt,
        runnerId: c.runnerId,
      })
      .from(c)
      .leftJoin(s, agentCredentialSecretJoin(q))
      .where(eq(c.accountId, accountId)),
  );
  return row
    ? { ...row, ciphertext: row.ciphertext ?? "", agent: row.agent as RunnerCodingAgent }
    : null;
}

export function* putAgentCredentialSecretSteps(
  q: Q,
  accountId: string,
  ciphertext: string | null,
  now: number,
): Steps<void> {
  const name = agentCredentialSecretName(accountId);
  const current = yield* readSecretSteps(q, name);
  if (current === null && ciphertext === null) return;
  yield* writeSecretSteps(q, name, ciphertext, current?.version ?? null, now);
}

export function* legacyAgentCredentialsSteps(q: Q) {
  const { agentAccountCredential: c } = q.t;
  return yield* q.all(
    q.orm
      .select({ accountId: c.accountId, ciphertext: c.ciphertext })
      .from(c)
      .where(ne(c.ciphertext, ""))
      .orderBy(asc(c.accountId)),
  );
}

export function* clearLegacyAgentCredentialSteps(q: Q, accountId: string, ciphertext: string) {
  const { agentAccountCredential: c } = q.t;
  const rows = yield* q.all(
    q.orm
      .update(c)
      .set({ ciphertext: "" })
      .where(and(eq(c.accountId, accountId), eq(c.ciphertext, ciphertext)))
      .returning({ accountId: c.accountId }),
  );
  return rows.length > 0;
}

export type AgentCredentialWrite = "written" | "stale_version";

export function* writeAgentCredentialCiphertextSteps(
  q: Q,
  input: {
    accountId: string;
    runnerId: string | null;
    version: number;
    ciphertext: string;
    now: number;
  },
): Steps<AgentCredentialWrite> {
  const { agentAccount, agentAccountCredential: c } = q.t;
  const account = yield* q.one(
    q.orm
      .select({ agent: agentAccount.agent, workspaceId: agentAccount.workspaceId })
      .from(agentAccount)
      .where(eq(agentAccount.id, input.accountId)),
  );
  if (!account) throw new AgentAccountError("not_found", "Agent account is unavailable");
  const stored = yield* agentCredentialCiphertextSteps(q, input.accountId);
  if ((stored?.version ?? 0) + 1 !== input.version) return "stale_version";
  const written = {
    agent: account.agent,
    ciphertext: "",
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
  if (rows.length === 0) return "stale_version";
  yield* putAgentCredentialSecretSteps(q, input.accountId, input.ciphertext, input.now);
  for (const binding of yield* listAgentBindingsSteps(q, account.workspaceId, input.accountId))
    if (binding.removedAt === null)
      yield* enqueueRunnerSetupChecksSteps(q, input.now, { runnerId: binding.runnerId });
  return "written";
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
  const { agentAccount: a, agentAccountCredential: c, secret: s } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        id: a.id,
        concurrency: a.concurrency,
        extraUsage: a.extraUsage,
      })
      .from(a)
      .leftJoin(c, eq(c.accountId, a.id))
      .leftJoin(s, agentCredentialSecretJoin(q))
      .where(
        and(
          CENTRAL_CREDENTIAL_AGENTS.includes(agent)
            ? and(isNotNull(c.accountId), ne(s.ciphertext, ""))
            : or(isNull(c.accountId), ne(s.ciphertext, "")),
          eq(a.workspaceId, workspaceId),
          eq(a.agent, agent),
          eq(a.enabled, 1),
          isNull(a.removedAt),
        ),
      )
      .orderBy(asc(a.position), asc(a.createdAt), asc(a.id)),
  );
  const eligible: CentralAgentAccount[] = [];
  for (const row of rows) {
    if (yield* agentAuthFailureSteps(q, row.id)) continue;
    const usage = yield* providerUsageSteps(q, row.id);
    eligible.push({
      id: row.id,
      concurrency: row.concurrency,
      extraUsage: row.extraUsage === 1,
      limits: usage?.limitsJson ? (JSON.parse(usage.limitsJson).limits as RunnerAgentLimit[]) : [],
    });
  }
  return eligible;
}
