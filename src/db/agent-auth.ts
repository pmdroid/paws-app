import { agentCredentialCiphertextSteps } from "./agent-account-credentials";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { AgentAccountError } from "./agent-accounts";
import { readSettingSteps, updateSettingSteps } from "./settings";
import type { Q, Steps } from "./db";
const key = (id: string) => `agent-auth:${id}`;
const DEVICE_AGENTS = ["codex", "opencode"] as const;
export function* deviceAccountSteps(
  q: Q,
  workspaceId: string,
  id: string,
): Steps<(typeof DEVICE_AGENTS)[number]> {
  const a = q.t.agentAccount;
  const row = yield* q.one(
    q.orm
      .select({ agent: a.agent })
      .from(a)
      .where(
        and(
          eq(a.id, id),
          eq(a.workspaceId, workspaceId),
          inArray(a.agent, [...DEVICE_AGENTS]),
          isNull(a.removedAt),
        ),
      ),
  );
  if (!row) throw new AgentAccountError("not_found", "Device sign-in account is unavailable");
  return row.agent as (typeof DEVICE_AGENTS)[number];
}
export function* readAgentAuthSteps(q: Q, id: string) {
  return yield* readSettingSteps(q, key(id));
}
export function* writeAgentAuthSteps(q: Q, id: string, value: string) {
  yield* updateSettingSteps(q, key(id), () => value);
}
export function* claimAgentAuthSteps(
  q: Q,
  id: string,
  before: string,
  after: string,
): Steps<boolean> {
  const s = q.t.setting;
  const rows = yield* q.all(
    q.orm
      .update(s)
      .set({ value: after })
      .where(and(eq(s.key, key(id)), eq(s.value, before)))
      .returning({ key: s.key }),
  );
  return rows.length === 1;
}
export function* listAgentAuthSteps(q: Q) {
  const s = q.t.setting;
  const a = q.t.agentAccount;
  const rows = yield* q.all(
    q.orm
      .select({ id: a.id, agent: a.agent, value: s.value })
      .from(a)
      .innerJoin(s, eq(s.key, sql`'agent-auth:' || ${a.id}`))
      .where(and(inArray(a.agent, [...DEVICE_AGENTS]), isNull(a.removedAt))),
  );
  return rows.map((row) => ({ ...row, agent: row.agent as (typeof DEVICE_AGENTS)[number] }));
}
export function* agentAuthFailureSteps(q: Q, id: string) {
  const raw = yield* readAgentAuthSteps(q, id);
  if (!raw) return null;
  const state = JSON.parse(raw) as {
    health?: string;
    version?: number;
    retryAt: number;
    failures: number;
  };
  const credential = yield* agentCredentialCiphertextSteps(q, id);
  return state.health === "auth-expired" &&
    credential?.ciphertext &&
    credential.version === state.version
    ? { ...state, updatedAt: credential.updatedAt }
    : null;
}
