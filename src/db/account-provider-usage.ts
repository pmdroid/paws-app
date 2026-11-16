import { and, eq, isNull } from "drizzle-orm";
import type { Q } from "./db";
import { ACCOUNT_RESET_SLACK_MS } from "./agent-account-health";
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
const UNKNOWN_RESET_RECHECK_MS = 300_000;

export function* saveProviderUsageSteps(
  q: Q,
  account: { id: string; workspaceId: string; agent: string; extraUsage?: boolean | number },
  limits: RunnerAgentLimit[],
  now: number,
) {
  const h = q.t.agentAccountHealth;
  const spent = account.extraUsage ? [] : limits.filter((limit) => limit.usedPercent >= 100);
  const resetsAt =
    spent.length === 0 || spent.some((limit) => limit.resetsAt === null)
      ? null
      : Math.max(...spent.map((limit) => limit.resetsAt!));
  const state = spent.length === 0 ? "ok" : "exhausted";
  const nextCheckAt =
    state === "ok"
      ? now
      : resetsAt === null
        ? now + UNKNOWN_RESET_RECHECK_MS
        : resetsAt + ACCOUNT_RESET_SLACK_MS;
  const values = {
    kind: "quota",
    scope: "account",
    scopeId: account.id,
    model: "",
    workspaceId: account.workspaceId,
    agent: account.agent,
    state,
    source: "login_check",
    sourceId: "provider-usage",
    observedAt: now,
    updatedAt: now,
    resetsAt,
    nextCheckAt,
    limitsJson: JSON.stringify({ limits, observedAt: now, stale: false }),
  };
  yield* q.exec(
    q.orm
      .insert(h)
      .values(values)
      .onConflictDoUpdate({
        target: [h.kind, h.scopeId, h.model],
        set:
          state === "exhausted"
            ? { limitsJson: values.limitsJson, state, resetsAt, nextCheckAt, updatedAt: now }
            : { limitsJson: values.limitsJson },
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
