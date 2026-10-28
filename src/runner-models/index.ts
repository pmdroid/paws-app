import { journalCaught } from "../journal";
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { immediate, runnerLeaseCutoff, workspaceMember } from "../db";
import type { RunnerWork } from "../runner-work";
import { RunnerHealthResultSchema, labelModels } from "../runner-protocol";

type Agent = "claude" | "codex" | "grok";
type Choice = { id: string; name: string };
type Source = {
  runnerId: string;
  workspaceId: string;
  userId: string;
  agent: Agent;
};
type Cached = Source & { model: string; resultJson: string; updatedAt: number };
type Pending = {
  commandId: string;
  runnerId: string;
  userId: string;
  agent: Agent;
  model: string;
  resultJson: string | null;
  expiresAt: number;
};
export type AgentModelCatalog = {
  agent: Agent;
  /** Labelled for people: a 1M entry is named "<model> · 1M context" and flagged. */
  models: Array<Choice & { longContext: boolean; efforts: Choice[] | null }>;
  efforts: Choice[];
  updatedAt: number;
};
const refreshMs = 6 * 60 * 60_000;
const retryMs = 10 * 60_000;
const concrete = (id: string) =>
  !["default", "auto", "claude", "codex", "grok"].includes(id.toLowerCase());
const eligible = `SELECT r.id AS runnerId,r.workspace_id AS workspaceId,r.owner_user_id AS userId,p.agent
 FROM runner r JOIN runner_agent_policy p ON p.runner_id=r.id
 JOIN workspace_member owner ON owner.workspace_id=r.workspace_id AND owner.user_id=r.owner_user_id
 WHERE r.status<>'revoked' AND r.revoked_at IS NULL AND p.ready=1 AND p.auth_expired=0 AND p.cooldown_until<=?
 AND owner.active=1`;

export function createRunnerModels(options: {
  db: Database;
  work: RunnerWork;
  now?: () => number;
}) {
  const { db, work } = options;
  const now = options.now ?? Date.now;
  const sources = (at = now()) => db.query<Source, [number]>(eligible).all(at);
  function cached(source: Source) {
    return db
      .query<Pick<Cached, "model" | "resultJson" | "updatedAt">, [string, string, string]>(
        "SELECT model,result_json AS resultJson,updated_at AS updatedAt FROM agent_model_catalog WHERE runner_id=? AND user_id=? AND agent=? ORDER BY updated_at DESC",
      )
      .all(source.runnerId, source.userId, source.agent)
      .map((row) => ({ ...source, ...row }));
  }
  function receive() {
    const pending = db
      .query<
        Pending,
        []
      >(`SELECT p.command_id AS commandId,p.runner_id AS runnerId,p.user_id AS userId,p.agent,p.model,h.result_json AS resultJson,c.expires_at AS expiresAt
      FROM agent_model_probe p JOIN runner_command c ON c.id=p.command_id LEFT JOIN runner_health_result h ON h.command_id=p.command_id WHERE p.finished_at IS NULL`)
      .all();
    for (const probe of pending) {
      if (!probe.resultJson && probe.expiresAt > now()) continue;
      immediate(db, () => {
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
            db.run(
              `INSERT INTO agent_model_catalog VALUES(?,?,?,?,?,?) ON CONFLICT(runner_id,user_id,agent,model) DO UPDATE SET result_json=excluded.result_json,updated_at=excluded.updated_at`,
              [probe.runnerId, probe.userId, probe.agent, probe.model, probe.resultJson, now()],
            );
          }
        }
        db.run("UPDATE agent_model_probe SET finished_at=? WHERE command_id=?", [
          now(),
          probe.commandId,
        ]);
      });
    }
  }
  function refresh() {
    receive();
    const available = sources().sort((a, b) => lastRequest(a) - lastRequest(b));
    for (const source of available) {
      const { runnerId, userId, agent } = source;
      if (
        !db
          .query("SELECT 1 FROM runner WHERE id=? AND status='active' AND last_seen_at>?")
          .get(runnerId, now() - 60_000)
      )
        continue;
      if (
        db
          .query(
            "SELECT 1 FROM runner_work WHERE runner_id=? AND ended_at IS NULL AND lease_until>? UNION ALL SELECT 1 FROM runner_helper WHERE runner_id=? AND ended_at IS NULL AND expires_at>?",
          )
          .get(runnerId, runnerLeaseCutoff(now()), runnerId, now())
      )
        continue;
      if (
        db
          .query(
            "SELECT 1 FROM runner_command c LEFT JOIN runner_health_result h ON h.command_id=c.id WHERE c.runner_id=? AND c.kind IN ('probe','login_check','login') AND c.expires_at>? AND h.command_id IS NULL AND NOT EXISTS(SELECT 1 FROM runner_login l WHERE l.id=c.id AND l.state IN ('connected','failed','cancelled','expired'))",
          )
          .get(runnerId, now())
      )
        continue;
      const rows = cached(source);
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
      immediate(db, () => {
        const commandId = randomUUID();
        work.enqueue({
          id: commandId,
          runnerId,
          workspaceId: source.workspaceId,
          type: "probe",
          profile: { agent, model: due || null },
          issuedAt: now(),
          expiresAt: now() + 120_000,
        });
        db.run("INSERT INTO agent_model_probe VALUES(?,?,?,?,?,?,NULL)", [
          commandId,
          runnerId,
          userId,
          agent,
          due,
          now(),
        ]);
      });
      return;
    }
  }
  function lastRequest(source: Source, model?: string): number {
    const row = db
      .query<{ at: number | null }, [string, string, string, string, string]>(
        "SELECT MAX(requested_at) AS at FROM agent_model_probe WHERE runner_id=? AND user_id=? AND agent=? AND (?='*' OR model=?)",
      )
      .get(source.runnerId, source.userId, source.agent, model ?? "*", model ?? "*");
    return row?.at ?? 0;
  }
  function read(principal: { workspaceId: string; userId: string }): AgentModelCatalog[] {
    if (!workspaceMember(db, principal.workspaceId, principal.userId)?.active)
      throw new Error("Workspace access is unavailable.");
    const rows = sources(Number.MAX_SAFE_INTEGER)
      .filter(
        (source) =>
          source.workspaceId === principal.workspaceId && source.userId === principal.userId,
      )
      .flatMap((source) => cached(source))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const catalogs: AgentModelCatalog[] = [];
    for (const agent of ["claude", "codex", "grok"] as const) {
      const header = rows.find((row) => row.agent === agent && row.model === "");
      if (!header) continue;
      const result = RunnerHealthResultSchema.parse(JSON.parse(header.resultJson));
      const efforts = (model: string) => {
        const row = rows.find((entry) => entry.agent === agent && entry.model === model);
        return row
          ? (RunnerHealthResultSchema.parse(JSON.parse(row.resultJson)).efforts ?? [])
          : null;
      };
      catalogs.push({
        agent,
        updatedAt: header.updatedAt,
        efforts: result.efforts ?? [],
        models: labelModels(result.models ?? [])
          .filter((model) => concrete(model.id))
          .map(({ id, name, longContext }) => ({
            id,
            name,
            longContext,
            efforts: efforts(id) ?? (result.identity?.model === id ? (result.efforts ?? []) : null),
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
