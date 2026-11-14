import { agentCredentialCiphertextSteps } from "./agent-account-credentials";
import { and, eq, isNull, sql } from "drizzle-orm";
import { AgentAccountError } from "./agent-accounts";
import { readSettingSteps, updateSettingSteps } from "./settings";
import type { Q, Steps } from "./db";
const key = (id: string) => `agent-auth:${id}`;
export function* deviceAccountSteps(q: Q, workspaceId: string, id: string): Steps<void> {
  const a = q.t.agentAccount;
  const row = yield* q.one(
    q.orm
      .select()
      .from(a)
      .where(
        and(
          eq(a.id, id),
          eq(a.workspaceId, workspaceId),
          eq(a.agent, "codex"),
          eq(a.legacy, 0),
          isNull(a.removedAt),
        ),
      ),
  );
  if (!row) throw new AgentAccountError("not_found", "Codex account is unavailable");
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
  return yield* q.all(
    q.orm
      .select({ id: a.id, value: s.value })
      .from(a)
      .innerJoin(s, eq(s.key, sql`'agent-auth:' || ${a.id}`))
      .where(and(eq(a.agent, "codex"), isNull(a.removedAt))),
  );
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
