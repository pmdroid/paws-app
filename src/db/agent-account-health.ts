import type { Database } from "bun:sqlite";
import { and, count, eq, gt, gte, isNull, sql } from "drizzle-orm";
import type { RunnerCodingAgent } from "../runner-protocol";
import { legacyAgentBindingId } from "./agent-accounts";
import { settled, sqliteDb, type Q, type Db } from "./db";

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

function* bindingForSteps(q: Q, bindingId: string) {
  const { agentAccount, agentAccountBinding: b, runner } = q.t;
  const found = yield* q.one(
    q.orm
      .select({
        id: b.id,
        workspaceId: b.workspaceId,
        accountId: b.accountId,
        agent: b.agent,
        runnerId: b.runnerId,
        quotaScope: b.quotaScope,
        live: sql<number>`CASE WHEN ${b.removedAt} IS NULL AND ${agentAccount.removedAt} IS NULL
          AND ${agentAccount.enabled}=1 AND ${runner.revokedAt} IS NULL
          AND ${runner.status}<>'revoked' THEN 1 ELSE 0 END`.mapWith(Number),
      })
      .from(b)
      .innerJoin(agentAccount, eq(agentAccount.id, b.accountId))
      .innerJoin(runner, eq(runner.id, b.runnerId))
      .where(eq(b.id, bindingId)),
  );
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

function* rowSteps(q: Q, kind: AccountHealthKind, scopeId: string, model: string) {
  const { agentAccountHealth: health } = q.t;
  const found = yield* q.one(
    q.orm
      .select()
      .from(health)
      .where(and(eq(health.kind, kind), eq(health.scopeId, scopeId), eq(health.model, model))),
  );
  return (found as AccountHealth | undefined) ?? null;
}

const KIND: Record<Exclude<AccountHealthState, "ok">, AccountHealthKind> = {
  low: "quota",
  exhausted: "quota",
  auth_required: "auth",
  restricted: "provider",
  unsupported_model: "model",
};

export function* recordAccountObservationSteps(q: Q, observation: AccountObservation) {
  const { agentAccountHealth: health } = q.t;
  const binding = yield* bindingForSteps(q, observation.bindingId);
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
    const current = yield* rowSteps(q, kind, scopeId, model);
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
    yield* q.exec(
      q.orm
        .insert(health)
        .values({
          kind,
          scopeId,
          model,
          workspaceId: binding.workspaceId,
          agent: binding.agent,
          ...update,
        })
        .onConflictDoUpdate({ target: [health.kind, health.scopeId, health.model], set: update }),
    );
    outcomes[kind] = "applied";
  }
  return outcomes;
}

export function recordAccountObservation(
  db: Database,
  observation: AccountObservation,
): Partial<Record<AccountHealthKind, AccountObservationOutcome>> {
  return settled(sqliteDb(db).transaction((q) => recordAccountObservationSteps(q, observation)));
}

/** When to look again at the quota limit a command's result recorded. */
export function* quotaRecheckAtSteps(q: Q, commandId: string, workspaceId: string) {
  const { agentAccountHealth: h } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ at: h.nextCheckAt })
      .from(h)
      .where(and(eq(h.kind, "quota"), eq(h.sourceId, commandId), eq(h.workspaceId, workspaceId))),
  );
  return row?.at ?? null;
}

export function quotaRecheckAt(
  db: Database,
  commandId: string,
  workspaceId: string,
): number | null {
  return settled(sqliteDb(db).run((q) => quotaRecheckAtSteps(q, commandId, workspaceId)));
}

export function* bindingAccountHealthSteps(q: Q, bindingId: string, model?: string | null) {
  const binding = yield* bindingForSteps(q, bindingId);
  if (!binding) return [];
  const found: AccountHealth[] = [];
  for (const kind of ["provider", "auth", "model", "quota"] as const) {
    if (kind === "model" && !model) continue;
    const health = yield* rowSteps(
      q,
      kind,
      scopeOf(binding, kind).scopeId,
      kind === "model" ? model! : "",
    );
    if (health) found.push(health);
  }
  return found;
}

export function bindingAccountHealth(
  db: Database,
  bindingId: string,
  model?: string | null,
): AccountHealth[] {
  return settled(sqliteDb(db).run((q) => bindingAccountHealthSteps(q, bindingId, model)));
}

export function* legacyBindingAccountHealthSteps(
  q: Q,
  runnerId: string,
  agent: string,
  model?: string | null,
) {
  const id = legacyAgentBindingId(runnerId, agent as RunnerCodingAgent);
  const { agentAccountBinding: b, runner } = q.t;
  if (yield* q.one(q.orm.select({ id: b.id }).from(b).where(eq(b.id, id))))
    return yield* bindingAccountHealthSteps(q, id, model);
  const workspace = yield* q.one(
    q.orm.select({ id: runner.workspaceId }).from(runner).where(eq(runner.id, runnerId)),
  );
  const provider = workspace
    ? yield* rowSteps(q, "provider", `${workspace.id}:${agent}`, "")
    : null;
  return provider ? [provider] : [];
}

export function legacyBindingAccountHealth(
  db: Database,
  runnerId: string,
  agent: string,
  model?: string | null,
): AccountHealth[] {
  return settled(
    sqliteDb(db).run((q) => legacyBindingAccountHealthSteps(q, runnerId, agent, model)),
  );
}

/** Attempts still running on the binding's account (or the binding itself) that began at or after `since`. */
export function* accountAttemptsInFlightSteps(
  q: Q,
  bindingId: string,
  since: number,
  scope: "account" | "binding",
) {
  const { agentAccountBinding: b, retroDispatch: d, runnerCommandAccount: c } = q.t;
  const u = q.t.runnerExecutionUsage;
  const owned = scope === "account" ? eq(c.accountId, b.accountId) : eq(c.bindingId, b.id);
  const usage = yield* q.one(
    q.orm
      .select({ count: count() })
      .from(u)
      .innerJoin(c, eq(c.commandId, u.commandId))
      .innerJoin(b, eq(b.id, bindingId))
      .where(and(isNull(u.endedAt), gte(u.startedAt, since), owned)),
  );
  const retros = yield* q.one(
    q.orm
      .select({ count: count() })
      .from(d)
      .innerJoin(c, eq(c.commandId, d.commandId))
      .innerJoin(b, eq(b.id, bindingId))
      .where(and(isNull(d.releasedAt), gte(d.createdAt, since), owned)),
  );
  return (usage?.count ?? 0) + (retros?.count ?? 0);
}

export function accountAttemptsInFlight(
  db: Database,
  bindingId: string,
  since: number,
  scope: "account" | "binding",
): number {
  return settled(sqliteDb(db).run((q) => accountAttemptsInFlightSteps(q, bindingId, since, scope)));
}

export function* resumeAccountHealthNowSteps(
  q: Q,
  agent: string,
  runnerId: string | null,
  now: number,
) {
  const { agentAccountHealth: health } = q.t;
  yield* q.exec(
    q.orm
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
      ),
  );
}

export async function resumeAccountHealthNow(
  store: Db,
  agent: string,
  runnerId: string | null,
  now: number,
): Promise<void> {
  await store.run((q) => resumeAccountHealthNowSteps(q, agent, runnerId, now));
}
