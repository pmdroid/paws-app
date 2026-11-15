import { and, eq, isNull } from "drizzle-orm";
import type { Q } from "./db";
import type { RunnerAgentLimit } from "./runners";
export function* usageAccountsSteps(q: Q) {
  const a = q.t.agentAccount;
  return yield* q.all(
    q.orm
      .select()
      .from(a)
      .where(and(isNull(a.removedAt), eq(a.enabled, 1), eq(a.legacy, 0))),
  );
}
export function* providerUsageSteps(q: Q, id: string) {
  const h = q.t.agentAccountHealth;
  return yield* q.one(
    q.orm
      .select()
      .from(h)
      .where(and(eq(h.scopeId, id), eq(h.kind, "quota"), eq(h.model, ""))),
  );
}
export function* saveProviderUsageSteps(
  q: Q,
  account: { id: string; workspaceId: string; agent: string },
  limits: RunnerAgentLimit[],
  now: number,
) {
  const h = q.t.agentAccountHealth;
  const values = {
    kind: "quota",
    scope: "account",
    scopeId: account.id,
    model: "",
    workspaceId: account.workspaceId,
    agent: account.agent,
    state: "ok",
    source: "login_check",
    sourceId: "provider-usage",
    observedAt: now,
    updatedAt: now,
    limitsJson: JSON.stringify({ limits, observedAt: now, stale: false }),
  };
  yield* q.exec(
    q.orm
      .insert(h)
      .values(values)
      .onConflictDoUpdate({
        target: [h.kind, h.scopeId, h.model],
        set: { limitsJson: values.limitsJson },
      }),
  );
}

export function* staleProviderUsageSteps(q: Q, id: string) {
  const previous = yield* providerUsageSteps(q, id);
  if (!previous?.limitsJson) return;
  const h = q.t.agentAccountHealth;
  yield* q.exec(
    q.orm
      .update(h)
      .set({ limitsJson: JSON.stringify({ ...JSON.parse(previous.limitsJson), stale: true }) })
      .where(and(eq(h.scopeId, id), eq(h.kind, "quota"), eq(h.model, ""))),
  );
}
