import { and, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { listAgentAccountsSteps, listAgentBindingsSteps } from "./agent-accounts";
import { bindingAccountHealthSteps } from "./agent-account-health";
import type { Q, Steps } from "./db";

export type SetupFacts = { github: boolean; runner: boolean; agent: boolean; delegated: boolean };

export function* setupFactsSteps(q: Q): Steps<SetupFacts> {
  const { workspaceGithubConnection: c, runner: r, workItem: w } = q.t;
  const connections = yield* q.all(
    q.orm
      .select({ repositories: c.repositories })
      .from(c)
      .where(and(isNotNull(c.secretId), isNotNull(c.installationId))),
  );
  const live = and(ne(r.status, "revoked"), isNull(r.revokedAt));
  const runner = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(r)
      .where(live)
      .limit(1),
  );
  const enrolled = yield* q.all(
    q.orm.select({ id: r.id, workspaceId: r.workspaceId }).from(r).where(live),
  );
  let agent = false;
  for (const workspaceId of new Set(enrolled.map((row) => row.workspaceId))) {
    const states = yield* onboardingAccountStatesSteps(q, workspaceId);
    agent ||= enrolled.some(
      (row) =>
        row.workspaceId === workspaceId &&
        Object.values(states.get(row.id) ?? {}).includes("connected"),
    );
  }
  const delegated = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(w)
      .limit(1),
  );
  return {
    github: connections.some((row) => listsRepository(row.repositories)),
    runner: runner !== undefined,
    agent,
    delegated: delegated !== undefined,
  };
}

function listsRepository(repositories: string): boolean {
  try {
    const names: unknown = JSON.parse(repositories);
    return Array.isArray(names) && names.some((name) => typeof name === "string");
  } catch {
    return false;
  }
}

export function* onboardingAccountStatesSteps(q: Q, workspaceId: string, ownerUserId?: string) {
  const accounts = (yield* listAgentAccountsSteps(q, workspaceId)).filter(
    (row) =>
      !row.legacy &&
      row.enabled &&
      row.removedAt === null &&
      (ownerUserId === undefined || row.ownerUserId === ownerUserId),
  );
  const bindings = yield* listAgentBindingsSteps(q, workspaceId);
  const states = new Map<string, Record<string, "connected" | "expired" | "waiting">>();
  for (const binding of bindings) {
    if (binding.removedAt !== null || !accounts.some((row) => row.id === binding.accountId))
      continue;
    const health = yield* bindingAccountHealthSteps(q, binding.id);
    const auth = health.find((row) => row.kind === "auth");
    const state =
      auth?.state === "ok" ? "connected" : auth?.state === "auth_required" ? "expired" : "waiting";
    const runner = states.get(binding.runnerId) ?? {};
    const previous = runner[binding.agent];
    if (previous !== "connected" && (previous !== "expired" || state === "connected"))
      runner[binding.agent] = state;
    states.set(binding.runnerId, runner);
  }
  return states;
}
