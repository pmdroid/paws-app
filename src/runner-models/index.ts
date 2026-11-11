import {
  agentModelSourcesSteps,
  cachedAgentModelsSteps,
  finishAgentModelProbeSteps,
  insertAgentModelProbeSteps,
  lastAgentModelProbeAtSteps,
  pendingAgentModelProbesSteps,
  runnerHasOpenWorkSteps,
  runnerHealthCommandOutstandingSteps,
  runnerStandingSteps,
  saveAgentModelCatalogSteps,
  settled,
  sqliteDb,
  workspaceMemberSteps,
  workspaceMemberUsable,
  type AgentModelSource,
  type Q,
  type Steps,
} from "../db";
import { journalCaught } from "../journal";
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { RunnerWork } from "../runner-work";
import { RunnerHealthResultSchema, labelModels } from "../runner-protocol";

type Agent = AgentModelSource["agent"];
type Choice = { id: string; name: string };
type Source = AgentModelSource;
export type AgentModelCatalog = {
  agent: Agent;
  /** Labelled for people: a 1M entry is named "<model> · 1M context" and flagged. */
  models: Array<
    Choice & { longContext: boolean; efforts: Choice[] | null; defaultEffort: string | null }
  >;
  efforts: Choice[];
  defaultModel: string | null;
  updatedAt: number;
};
const refreshMs = 6 * 60 * 60_000;
const retryMs = 10 * 60_000;
const concrete = (id: string) =>
  !["default", "auto", "claude", "codex", "grok", "opencode"].includes(id.toLowerCase());

export function createRunnerModels(options: {
  db: Database;
  work: RunnerWork;
  now?: () => number;
}) {
  const { db, work } = options;
  const store = sqliteDb(db);
  const transaction = <T>(body: (q: Q) => Steps<T>) => settled(store.transaction(body));
  const run = <T>(body: (q: Q) => Steps<T>) => settled(store.run(body));
  const now = options.now ?? Date.now;
  function* sourcesSteps(q: Q, at = now()) {
    const supported: Source[] = [];
    for (const source of yield* agentModelSourcesSteps(q, at))
      if (yield* work.supportsAgentSteps(q, source.runnerId, source.agent)) supported.push(source);
    return supported;
  }
  function* cachedSteps(q: Q, source: Source) {
    return (yield* cachedAgentModelsSteps(q, source)).map((row) => ({ ...source, ...row }));
  }
  function receive() {
    const pending = run(pendingAgentModelProbesSteps);
    for (const probe of pending) {
      if (!probe.resultJson && probe.expiresAt > now()) continue;
      transaction(function* (q) {
        if (probe.resultJson) {
          const result = RunnerHealthResultSchema.parse(JSON.parse(probe.resultJson));
          if (
            result.stopReason === "end_turn" &&
            result.agentExited &&
            !result.authRequired &&
            !result.cancelled &&
            !result.timedOut &&
            !result.errorMessage &&
            result.models?.length &&
            (!probe.model || result.identity?.model === probe.model)
          ) {
            yield* saveAgentModelCatalogSteps(q, {
              runnerId: probe.runnerId,
              userId: probe.userId,
              agent: probe.agent,
              model: probe.model,
              resultJson: probe.resultJson,
              updatedAt: now(),
            });
          }
        }
        yield* finishAgentModelProbeSteps(q, probe.commandId, now());
      });
    }
  }
  function refresh() {
    receive();
    const available = run((q) => sourcesSteps(q)).sort((a, b) => lastRequest(a) - lastRequest(b));
    for (const source of available) {
      const { runnerId, userId, agent } = source;
      const standing = run((q) => runnerStandingSteps(q, runnerId));
      if (
        standing?.status !== "active" ||
        standing.lastSeenAt === null ||
        standing.lastSeenAt <= now() - 60_000
      )
        continue;
      if (run((q) => runnerHasOpenWorkSteps(q, runnerId, now()))) continue;
      if (run((q) => runnerHealthCommandOutstandingSteps(q, runnerId, now()))) continue;
      const rows = run((q) => cachedSteps(q, source));
      const header = rows.find((row) => row.model === "");
      const catalog = header ? RunnerHealthResultSchema.parse(JSON.parse(header.resultJson)) : null;
      const due = ["", ...(catalog?.models ?? []).map((model) => model.id).filter(concrete)].find(
        (model) => {
          const row =
            rows.find((entry) => entry.model === model) ??
            (model && catalog?.identity?.model === model ? header : undefined);
          return (
            (!row || row.updatedAt <= now() - refreshMs) &&
            (!lastRequest(source, model) || lastRequest(source, model) <= now() - retryMs)
          );
        },
      );
      if (due === undefined) continue;
      transaction(function* (q) {
        const commandId = randomUUID();
        yield* work.enqueueSteps(q, {
          id: commandId,
          runnerId,
          workspaceId: source.workspaceId,
          type: "probe",
          profile: { agent, model: due || null },
          issuedAt: now(),
          expiresAt: now() + 120_000,
        });
        yield* insertAgentModelProbeSteps(q, {
          commandId,
          runnerId,
          userId,
          agent,
          model: due,
          requestedAt: now(),
        });
      });
      return;
    }
  }
  function lastRequest(source: Source, model?: string): number {
    return run((q) => lastAgentModelProbeAtSteps(q, source, model));
  }
  function read(principal: { workspaceId: string; userId: string }): AgentModelCatalog[] {
    const rows = run(function* (q) {
      if (
        !workspaceMemberUsable(
          yield* workspaceMemberSteps(q, principal.workspaceId, principal.userId),
        )
      )
        throw new Error("Workspace access is unavailable.");
      const owned = [];
      for (const source of yield* sourcesSteps(q, Number.MAX_SAFE_INTEGER))
        if (source.workspaceId === principal.workspaceId && source.userId === principal.userId)
          owned.push(...(yield* cachedSteps(q, source)));
      return owned;
    }).sort((a, b) => b.updatedAt - a.updatedAt);
    const catalogs: AgentModelCatalog[] = [];
    for (const agent of ["claude", "codex", "grok", "opencode"] as const) {
      const header = rows.find((row) => row.agent === agent && row.model === "");
      if (!header) continue;
      const result = RunnerHealthResultSchema.parse(JSON.parse(header.resultJson));
      const probed = (model: string) => {
        const row = rows.find((entry) => entry.agent === agent && entry.model === model);
        return row ? RunnerHealthResultSchema.parse(JSON.parse(row.resultJson)) : null;
      };
      const current = (model: string) =>
        probed(model) ?? (result.identity?.model === model ? result : null);
      catalogs.push({
        agent,
        updatedAt: header.updatedAt,
        efforts: result.efforts ?? [],
        defaultModel: result.identity?.model ?? null,
        models: labelModels(result.models ?? [])
          .filter((model) => concrete(model.id))
          .map(({ id, name, longContext }) => ({
            id,
            name,
            longContext,
            efforts: current(id) ? (current(id)!.efforts ?? []) : null,
            defaultEffort: current(id)?.effort ?? null,
          })),
      });
    }
    return catalogs;
  }
  return {
    refresh,
    read,
    async browser(request: Request, principal: { workspaceId: string; userId: string }) {
      if (new URL(request.url).pathname !== "/api/runners/models") return null;
      if (request.method !== "GET") return Response.json({ error: "Use GET." }, { status: 405 });
      try {
        return Response.json(
          { catalogs: read(principal) },
          { headers: { "cache-control": "no-store" } },
        );
      } catch (caughtError1) {
        journalCaught(caughtError1, "runner-models.browser.json", null);
        return Response.json({ error: "Agent model choices are unavailable." }, { status: 403 });
      }
    },
  };
}
