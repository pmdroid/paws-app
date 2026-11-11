import { and, desc, eq, isNull, lte, max, ne, sql } from "drizzle-orm";
import { type Q, type Db } from "./db";
import { jsonFromText, jsonText } from "./json-text";
import { workspaceMemberUsableWhere } from "./workspace";

type Agent = "claude" | "codex" | "grok" | "opencode";

export type AgentModelSource = {
  runnerId: string;
  workspaceId: string;
  userId: string;
  agent: Agent;
};

export function* agentModelSourcesSteps(q: Q, at: number) {
  const { runner: r, runnerAgentPolicy: p, workspaceMember: owner } = q.t;
  return yield* q.all(
    q.orm
      .select({
        runnerId: r.id,
        workspaceId: r.workspaceId,
        userId: r.ownerUserId,
        agent: sql<Agent>`${p.agent}`,
      })
      .from(r)
      .innerJoin(p, eq(p.runnerId, r.id))
      .innerJoin(owner, and(eq(owner.workspaceId, r.workspaceId), eq(owner.userId, r.ownerUserId)))
      .where(
        and(
          ne(r.status, "revoked"),
          isNull(r.revokedAt),
          eq(p.ready, 1),
          eq(p.authExpired, 0),
          lte(p.cooldownUntil, at),
          workspaceMemberUsableWhere(owner),
        ),
      ),
  );
}

export async function agentModelSources(store: Db, at: number): Promise<AgentModelSource[]> {
  return store.run((q) => agentModelSourcesSteps(q, at));
}

type ProbeOwner = { runnerId: string; userId: string; agent: string };

export function* cachedAgentModelsSteps(q: Q, owner: ProbeOwner) {
  const { agentModelCatalog: m } = q.t;
  return yield* q.all(
    q.orm
      .select({
        model: m.model,
        resultJson: jsonText(q, m.resultJson),
        updatedAt: m.updatedAt,
      })
      .from(m)
      .where(
        and(eq(m.runnerId, owner.runnerId), eq(m.userId, owner.userId), eq(m.agent, owner.agent)),
      )
      .orderBy(desc(m.updatedAt)),
  );
}

export async function cachedAgentModels(
  store: Db,
  owner: ProbeOwner,
): Promise<{ model: string; resultJson: string; updatedAt: number }[]> {
  return store.run((q) => cachedAgentModelsSteps(q, owner));
}

export type PendingAgentModelProbe = {
  commandId: string;
  runnerId: string;
  userId: string;
  agent: Agent;
  model: string;
  resultJson: string | null;
  expiresAt: number;
};

export function* pendingAgentModelProbesSteps(q: Q) {
  const { agentModelProbe: p, runnerCommand: c, runnerHealthResult: h } = q.t;
  return yield* q.all(
    q.orm
      .select({
        commandId: p.commandId,
        runnerId: p.runnerId,
        userId: p.userId,
        agent: sql<Agent>`${p.agent}`,
        model: p.model,
        resultJson: h.resultJson,
        expiresAt: c.expiresAt,
      })
      .from(p)
      .innerJoin(c, eq(c.id, p.commandId))
      .leftJoin(h, eq(h.commandId, p.commandId))
      .where(isNull(p.finishedAt)),
  );
}

export async function pendingAgentModelProbes(store: Db): Promise<PendingAgentModelProbe[]> {
  return store.run((q) => pendingAgentModelProbesSteps(q));
}

type AgentModelEntry = ProbeOwner & { model: string; resultJson: string; updatedAt: number };

export function* saveAgentModelCatalogSteps(q: Q, entry: AgentModelEntry) {
  const { agentModelCatalog: m } = q.t;
  yield* q.exec(
    q.orm
      .insert(m)
      .values({ ...entry, resultJson: jsonFromText(q, entry.resultJson) })
      .onConflictDoUpdate({
        target: [m.runnerId, m.userId, m.agent, m.model],
        set: {
          resultJson: sql`excluded.result_json`,
          updatedAt: sql`excluded.updated_at`,
        },
      }),
  );
}

export async function saveAgentModelCatalog(store: Db, entry: AgentModelEntry): Promise<void> {
  await store.run((q) => saveAgentModelCatalogSteps(q, entry));
}

export function* finishAgentModelProbeSteps(q: Q, commandId: string, at: number) {
  const { agentModelProbe: p } = q.t;
  yield* q.exec(q.orm.update(p).set({ finishedAt: at }).where(eq(p.commandId, commandId)));
}

export async function finishAgentModelProbe(
  store: Db,
  commandId: string,
  at: number,
): Promise<void> {
  await store.run((q) => finishAgentModelProbeSteps(q, commandId, at));
}

type NewAgentModelProbe = ProbeOwner & { commandId: string; model: string; requestedAt: number };

export function* insertAgentModelProbeSteps(q: Q, probe: NewAgentModelProbe) {
  yield* q.exec(q.orm.insert(q.t.agentModelProbe).values({ ...probe, finishedAt: null }));
}

export async function insertAgentModelProbe(store: Db, probe: NewAgentModelProbe): Promise<void> {
  await store.run((q) => insertAgentModelProbeSteps(q, probe));
}

export function* lastAgentModelProbeAtSteps(q: Q, owner: ProbeOwner, model?: string) {
  const { agentModelProbe: p } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ at: max(p.requestedAt) })
      .from(p)
      .where(
        and(
          eq(p.runnerId, owner.runnerId),
          eq(p.userId, owner.userId),
          eq(p.agent, owner.agent),
          model === undefined ? undefined : eq(p.model, model),
        ),
      ),
  );
  return row?.at ?? 0;
}

export async function lastAgentModelProbeAt(
  store: Db,
  owner: ProbeOwner,
  model?: string,
): Promise<number> {
  return store.run((q) => lastAgentModelProbeAtSteps(q, owner, model));
}
