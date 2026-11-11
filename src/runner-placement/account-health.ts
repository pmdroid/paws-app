import type { Database } from "bun:sqlite";
import {
  accountAttemptsInFlightSteps,
  accountSlotsInUseSteps,
  bindingAccountHealthSteps,
  bindingReadinessRowSteps,
  runnerHasCapacitySteps,
  settled,
  sqliteDb,
  RUNNER_FULL,
  type AccountHealth,
  type Q,
  type Steps,
} from "../db";
import type { RunnerHelperResult, RunnerResult } from "../runner-protocol";
import { RUNNER_ONLINE_MS } from "./eligible";
import { quotaSignal, type QuotaSignal } from "../core";

export type AgentFailureKind = "ok" | "quota" | "auth" | "provider" | "model" | "runner" | "task";

export type AgentFailure = { kind: AgentFailureKind; quota: QuotaSignal | null };

const PROVIDER_RESTRICTED =
  /(?:not\s+(?:available|supported)|unavailable)\s+in\s+your\s+(?:country|region|location|territory)|unsupported\s+(?:country|region|territory)|overloaded[ _]error|(?:api|service|servers?)\s+(?:is\s+|are\s+)?(?:currently\s+|temporarily\s+)?overloaded|(?:HTTP|status(?:\s+code)?)\s*:?\s*529\b/i;
const MODEL_UNSUPPORTED =
  /\bmodel\b[^\n]{0,80}?(?:not\s+found|does\s+not\s+exist|is\s+not\s+supported|not\s+available\s+(?:for|to|on)\s+(?:your|this)|unsupported)|(?:invalid|unknown|unsupported)\s+model\b|(?:do(?:es)?\s+not|don't)\s+have\s+access\s+to\s+(?:the\s+)?model/i;

export function classifyAgentFailure(input: {
  result?: RunnerResult | RunnerHelperResult;
  failure?: "heartbeat_lost" | "cancelled" | "timeout" | "error";
  now: number;
}): AgentFailure {
  const { result } = input;
  if (result?.authRequired) return { kind: "auth", quota: null };
  const message = result?.errorMessage ?? "";
  const quota = message ? quotaSignal(message, input.now) : null;
  if (quota?.state === "exhausted") return { kind: "quota", quota };
  if (PROVIDER_RESTRICTED.test(message.slice(0, 16_384))) return { kind: "provider", quota };
  if (MODEL_UNSUPPORTED.test(message.slice(0, 16_384))) return { kind: "model", quota };
  if (input.failure && input.failure !== "error") return { kind: "runner", quota };
  if (
    !input.failure &&
    result &&
    result.stopReason === "end_turn" &&
    !result.cancelled &&
    !result.timedOut &&
    !result.errorMessage
  )
    return { kind: "ok", quota };
  return { kind: input.failure || result?.agentExited === false ? "runner" : "task", quota };
}

export type BindingUnavailableReason =
  | "revoked"
  | "removed"
  | "disabled"
  | "offline"
  | "paused"
  | "busy"
  | "auth-required"
  | "exhausted"
  | "provider-restricted"
  | "unsupported-model";

export type BindingReadiness =
  | { ready: true; low: boolean; revalidating: boolean }
  | { ready: false; reason: BindingUnavailableReason; until: number | null };

type HealthBlock = { reason: BindingUnavailableReason; until: number | null } | null;

const BLOCKS: Partial<Record<AccountHealth["state"], BindingUnavailableReason>> = {
  exhausted: "exhausted",
  auth_required: "auth-required",
  restricted: "provider-restricted",
  unsupported_model: "unsupported-model",
};

function* healthBlockSteps(
  q: Q,
  bindingId: string,
  rows: readonly AccountHealth[],
  now: number,
): Steps<HealthBlock> {
  for (const row of rows) {
    const reason = BLOCKS[row.state];
    if (!reason) continue;
    if (row.nextCheckAt === null || row.nextCheckAt > now)
      return { reason, until: row.nextCheckAt };
    const scope = row.scope === "account" ? "account" : "binding";
    if (
      row.kind !== "provider" &&
      (yield* accountAttemptsInFlightSteps(q, bindingId, row.observedAt, scope)) > 0
    )
      return { reason, until: null };
  }
  return null;
}

function* bindingReadinessSteps(
  q: Q,
  input: { bindingId: string; model?: string | null; now: number },
): Steps<BindingReadiness> {
  const binding = yield* bindingReadinessRowSteps(q, input.bindingId);
  const unavailable = (reason: BindingUnavailableReason, until: number | null = null) =>
    ({ ready: false, reason, until }) as const;
  if (!binding) return unavailable("removed");
  if (binding.revokedAt !== null || binding.status === "revoked") return unavailable("revoked");
  if (binding.bindingRemoved !== null || binding.accountRemoved !== null)
    return unavailable("removed");
  if (binding.enabled !== 1) return unavailable("disabled");
  if ((binding.lastSeenAt ?? 0) <= input.now - RUNNER_ONLINE_MS) return unavailable("offline");
  if (binding.legacy === 1 && binding.authExpired === 1) return unavailable("auth-required");
  const rows = yield* bindingAccountHealthSteps(q, input.bindingId, input.model);
  const blocked = yield* healthBlockSteps(q, input.bindingId, rows, input.now);
  if (blocked) return unavailable(blocked.reason, blocked.until);
  if (binding.status !== "active") return unavailable("paused");
  if (!(yield* runnerHasCapacitySteps(q, binding.runnerId, input.now))) return unavailable("busy");
  if (
    binding.concurrency !== null &&
    (yield* accountSlotsInUseSteps(q, binding.accountId, input.now)) >= binding.concurrency
  )
    return unavailable("busy");
  return {
    ready: true,
    low: rows.some((row) => row.state === "low"),
    revalidating: rows.some((row) => BLOCKS[row.state] !== undefined),
  };
}

export function bindingReadiness(
  db: Database,
  input: { bindingId: string; model?: string | null; now: number },
): BindingReadiness {
  return settled(sqliteDb(db).run((q) => bindingReadinessSteps(q, input)));
}

export function* accountHealthBlockSteps(
  q: Q,
  bindingId: string,
  rows: readonly AccountHealth[],
  now: number,
  purpose: "prepare" | "work" | "helper",
): Steps<HealthBlock> {
  return yield* healthBlockSteps(
    q,
    bindingId,
    purpose === "prepare" ? rows.filter((row) => row.kind !== "auth") : rows,
    now,
  );
}

export const BINDING_REASON_TEXT: Record<BindingUnavailableReason, string> = {
  revoked: "runner revoked",
  removed: "agent account binding removed",
  disabled: "agent account disabled",
  offline: "runner offline",
  paused: "runner paused",
  busy: RUNNER_FULL,
  "auth-required": "agent account sign-in needs repair",
  exhausted: "agent account quota cooldown",
  "provider-restricted": "agent provider restricted",
  "unsupported-model": "model unavailable to the agent account",
};
