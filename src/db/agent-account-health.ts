import type { Database } from "bun:sqlite";
import type { RunnerCodingAgent } from "../runner-protocol";
import { legacyAgentBindingId } from "./agent-accounts";
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

const columns =
  "kind,scope,scope_id AS scopeId,model,workspace_id AS workspaceId,agent,state,source,source_id AS sourceId,binding_id AS bindingId,runner_id AS runnerId,observed_at AS observedAt,resets_at AS resetsAt,next_check_at AS nextCheckAt,failures,updated_at AS updatedAt";

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
  return db
    .query<Binding, [string]>(
      `SELECT b.id,b.workspace_id AS workspaceId,b.account_id AS accountId,b.agent,b.runner_id AS runnerId,
       b.quota_scope AS quotaScope,
       (b.removed_at IS NULL AND a.removed_at IS NULL AND a.enabled=1 AND r.revoked_at IS NULL
         AND r.status<>'revoked') AS live
       FROM agent_account_binding b JOIN agent_account a ON a.id=b.account_id
       JOIN runner r ON r.id=b.runner_id WHERE b.id=?`,
    )
    .get(bindingId);
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
  return db
    .query<AccountHealth, [string, string, string]>(
      `SELECT ${columns} FROM agent_account_health WHERE kind=? AND scope_id=? AND model=?`,
    )
    .get(kind, scopeId, model);
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
      db.run(
        `INSERT INTO agent_account_health(kind,scope,scope_id,model,workspace_id,agent,state,source,source_id,
         binding_id,runner_id,observed_at,resets_at,next_check_at,failures,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(kind,scope_id,model) DO UPDATE SET scope=excluded.scope,state=excluded.state,
         source=excluded.source,source_id=excluded.source_id,binding_id=excluded.binding_id,
         runner_id=excluded.runner_id,observed_at=excluded.observed_at,resets_at=excluded.resets_at,
         next_check_at=excluded.next_check_at,failures=excluded.failures,updated_at=excluded.updated_at`,
        [
          kind,
          scope,
          scopeId,
          model,
          binding.workspaceId,
          binding.agent,
          state,
          observation.source,
          observation.sourceId,
          binding.id,
          binding.runnerId,
          observation.observedAt,
          resetsAt,
          nextCheckAt,
          Math.min(failures, 1000),
          observation.now,
        ],
      );
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
  if (db.query("SELECT 1 FROM agent_account_binding WHERE id=?").get(id))
    return bindingAccountHealth(db, id, model);
  const workspace = db
    .query<{ id: string }, [string]>("SELECT workspace_id AS id FROM runner WHERE id=?")
    .get(runnerId);
  const provider = workspace ? row(db, "provider", `${workspace.id}:${agent}`, "") : null;
  return provider ? [provider] : [];
}

export function accountAttemptsInFlight(
  db: Database,
  bindingId: string,
  since: number,
  scope: "account" | "binding",
): number {
  return db
    .query<{ count: number }, [string, number]>(
      `SELECT COUNT(*) AS count FROM (
         SELECT u.command_id FROM runner_execution_usage u
         WHERE u.ended_at IS NULL AND u.started_at>=?2
         UNION ALL
         SELECT d.command_id FROM retro_dispatch d
         WHERE d.released_at IS NULL AND d.created_at>=?2
       ) a
       JOIN runner_command_account c ON c.command_id=a.command_id
       JOIN agent_account_binding b ON b.id=?1
       WHERE ${scope === "account" ? "c.account_id=b.account_id" : "c.binding_id=b.id"}`,
    )
    .get(bindingId, since)!.count;
}

export function resumeAccountHealthNow(
  db: Database,
  agent: string,
  runnerId: string | null,
  now: number,
): void {
  db.run(
    `UPDATE agent_account_health SET next_check_at=?1,updated_at=?1 WHERE agent=?2 AND kind='quota'
     AND state='exhausted' AND next_check_at>?1 AND (?3 IS NULL OR runner_id=?3)`,
    [now, agent, runnerId],
  );
}
