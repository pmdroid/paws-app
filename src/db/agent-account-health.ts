import type { Database } from "bun:sqlite";
import { and, eq, gt, sql } from "drizzle-orm";
import type { RunnerCodingAgent } from "../runner-protocol";
import { legacyAgentBindingId } from "./agent-accounts";
import { orm } from "./orm";
import { agentAccount, agentAccountBinding, agentAccountHealth as health, runner } from "./schema";
import { immediate } from "./tx";

export type AccountHealthKind = "quota" | "auth" | "provider" | "model";
export type AccountHealthState =
  | "ok"
  | "low"
  | "exhausted"
  | "auth_required"
  | "restricted"
  | "unsupported_model";
export type AccountHealthSource = "result" | "login_check" | "sign_in" | "resume";

export type AccountHealth = {
  kind: AccountHealthKind;
  scope: "account" | "binding" | "provider";
  scopeId: string;
  model: string;
  workspaceId: string;
  agent: RunnerCodingAgent;
  state: AccountHealthState;
  source: AccountHealthSource;
  sourceId: string;
  bindingId: string;
  runnerId: string;
  observedAt: number;
  resetsAt: number | null;
  nextCheckAt: number | null;
  failures: number;
  updatedAt: number;
};

export type AccountObservation = {
  bindingId: string;
  source: AccountHealthSource;
  sourceId: string;
  observedAt: number;
  now: number;
  model?: string | null;
} & (
  | { state: "exhausted"; resetsAt: number | null }
  | { state: "low" | "auth_required" | "restricted" }
  | { state: "unsupported_model"; model: string }
  | { state: "ok"; clears: readonly AccountHealthKind[] }
);

export type AccountObservationOutcome = "applied" | "stale" | "duplicate" | "removed";

export const ACCOUNT_RECHECK_BASE_MS = 15 * 60_000;
export const ACCOUNT_RECHECK_MAX_MS = 4 * 60 * 60_000;
export const ACCOUNT_RESET_SLACK_MS = 60_000;
export const ACCOUNT_MODEL_RECHECK_MS = 6 * 60 * 60_000;

export function accountRecheckDelay(scopeId: string, failures: number): number {
  const exponent = Math.min(Math.max(failures, 1) - 1, 16);
  const delay = Math.min(ACCOUNT_RECHECK_BASE_MS * 2 ** exponent, ACCOUNT_RECHECK_MAX_MS);
  let hash = 2_166_136_261;
  for (const char of `${scopeId}:${failures}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return Math.round(delay * (0.8 + ((hash % 4001) / 4000) * 0.4));
}

type Binding = {
  id: string;
  workspaceId: string;
  accountId: string;
  agent: RunnerCodingAgent;
  runnerId: string;
  quotaScope: "account" | "unknown";
  live: number;
};

function bindingFor(db: Database, bindingId: string): Binding | null {
  const b = agentAccountBinding;
  const found = orm(db)
    .select({
      id: b.id,
      workspaceId: b.workspaceId,
      accountId: b.accountId,
      agent: b.agent,
      runnerId: b.runnerId,
      quotaScope: b.quotaScope,
      live: sql<number>`(${b.removedAt} IS NULL AND ${agentAccount.removedAt} IS NULL
        AND ${agentAccount.enabled}=1 AND ${runner.revokedAt} IS NULL AND ${runner.status}<>'revoked')`,
    })
    .from(b)
    .innerJoin(agentAccount, eq(agentAccount.id, b.accountId))
    .innerJoin(runner, eq(runner.id, b.runnerId))
    .where(eq(b.id, bindingId))
    .get();
  return (found as Binding | undefined) ?? null;
}

function scopeOf(binding: Binding, kind: AccountHealthKind) {
  if (kind === "provider")
    return { scope: "provider" as const, scopeId: `${binding.workspaceId}:${binding.agent}` };
  if (kind === "auth") return { scope: "binding" as const, scopeId: binding.id };
  return binding.quotaScope === "account"
    ? { scope: "account" as const, scopeId: binding.accountId }
    : { scope: "binding" as const, scopeId: binding.id };
}

function row(db: Database, kind: AccountHealthKind, scopeId: string, model: string) {
  const found = orm(db)
    .select()
    .from(health)
    .where(and(eq(health.kind, kind), eq(health.scopeId, scopeId), eq(health.model, model)))
    .get();
  return (found as AccountHealth | undefined) ?? null;
}

const KIND: Record<Exclude<AccountHealthState, "ok">, AccountHealthKind> = {
  low: "quota",
  exhausted: "quota",
  auth_required: "auth",
  restricted: "provider",
  unsupported_model: "model",
};

export function recordAccountObservation(
  db: Database,
  observation: AccountObservation,
): Partial<Record<AccountHealthKind, AccountObservationOutcome>> {
  return immediate(db, () => {
    const binding = bindingFor(db, observation.bindingId);
    if (!binding) throw new Error("Agent account binding is unavailable");
    const kinds: readonly AccountHealthKind[] =
      observation.state === "ok"
        ? observation.clears.filter((kind) => kind !== "model" || observation.model)
        : [KIND[observation.state]];
    const outcomes: Partial<Record<AccountHealthKind, AccountObservationOutcome>> = {};
    const failure = observation.state !== "ok" && observation.state !== "low";
    for (const kind of kinds) {
      if (observation.state === "ok" && !binding.live) {
        outcomes[kind] = "removed";
        continue;
      }
      const { scope, scopeId } = scopeOf(binding, kind);
      const model = kind === "model" ? (observation.model ?? "") : "";
      const current = row(db, kind, scopeId, model);
      if (current?.sourceId === observation.sourceId) {
        outcomes[kind] = "duplicate";
        continue;
      }
      if (
        current &&
        (observation.observedAt < current.observedAt ||
          (observation.observedAt === current.observedAt && !failure))
      ) {
        outcomes[kind] = "stale";
        continue;
      }
      const state = observation.state;
      const failures = failure ? (current?.state === state ? current.failures : 0) + 1 : 0;
      const resetsAt = state === "exhausted" ? observation.resetsAt : null;
      const nextCheckAt =
        state === "auth_required"
          ? null
          : state === "unsupported_model"
            ? observation.observedAt + ACCOUNT_MODEL_RECHECK_MS
            : resetsAt !== null
              ? resetsAt + ACCOUNT_RESET_SLACK_MS
              : failure
                ? observation.observedAt + accountRecheckDelay(scopeId, failures)
                : observation.observedAt;
      const update = {
        scope,
        state,
        source: observation.source,
        sourceId: observation.sourceId,
        bindingId: binding.id,
        runnerId: binding.runnerId,
        observedAt: observation.observedAt,
        resetsAt,
        nextCheckAt,
        failures: Math.min(failures, 1000),
        updatedAt: observation.now,
      };
      orm(db)
        .insert(health)
        .values({
          kind,
          scopeId,
          model,
          workspaceId: binding.workspaceId,
          agent: binding.agent,
          ...update,
        })
        .onConflictDoUpdate({ target: [health.kind, health.scopeId, health.model], set: update })
        .run();
      outcomes[kind] = "applied";
    }
    return outcomes;
  });
}

export function bindingAccountHealth(
  db: Database,
  bindingId: string,
  model?: string | null,
): AccountHealth[] {
  const binding = bindingFor(db, bindingId);
  if (!binding) return [];
  return (["provider", "auth", "model", "quota"] as const).flatMap((kind) => {
    if (kind === "model" && !model) return [];
    const found = row(db, kind, scopeOf(binding, kind).scopeId, kind === "model" ? model! : "");
    return found ? [found] : [];
  });
}

export function legacyBindingAccountHealth(
  db: Database,
  runnerId: string,
  agent: string,
  model?: string | null,
): AccountHealth[] {
  const id = legacyAgentBindingId(runnerId, agent as RunnerCodingAgent);
  const b = agentAccountBinding;
  if (orm(db).select({ id: b.id }).from(b).where(eq(b.id, id)).get())
    return bindingAccountHealth(db, id, model);
  const workspace = orm(db)
    .select({ id: runner.workspaceId })
    .from(runner)
    .where(eq(runner.id, runnerId))
    .get();
  const provider = workspace ? row(db, "provider", `${workspace.id}:${agent}`, "") : null;
  return provider ? [provider] : [];
}

export function accountAttemptsInFlight(
  db: Database,
  bindingId: string,
  since: number,
  scope: "account" | "binding",
): number {
  return orm(db).all<{ count: number }>(
    sql`SELECT COUNT(*) AS count FROM (
         SELECT u.command_id FROM runner_execution_usage u
         WHERE u.ended_at IS NULL AND u.started_at>=${since}
         UNION ALL
         SELECT d.command_id FROM retro_dispatch d
         WHERE d.released_at IS NULL AND d.created_at>=${since}
       ) a
       JOIN runner_command_account c ON c.command_id=a.command_id
       JOIN agent_account_binding b ON b.id=${bindingId}
       WHERE ${sql.raw(scope === "account" ? "c.account_id=b.account_id" : "c.binding_id=b.id")}`,
  )[0]!.count;
}

export function resumeAccountHealthNow(
  db: Database,
  agent: string,
  runnerId: string | null,
  now: number,
): void {
  orm(db)
    .update(health)
    .set({ nextCheckAt: now, updatedAt: now })
    .where(
      and(
        eq(health.agent, agent),
        eq(health.kind, "quota"),
        eq(health.state, "exhausted"),
        gt(health.nextCheckAt, now),
        runnerId === null ? undefined : eq(health.runnerId, runnerId),
      ),
    )
    .run();
}
