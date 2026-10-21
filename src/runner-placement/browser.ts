import type { Database } from "bun:sqlite";
import { z } from "zod";
import { auditWorkspaceAccess, immediate, workspaceMember } from "../db";
import { RunnerHealthResultSchema, labelModels } from "../runner-protocol";
import type { WorkspacePrincipal } from "../workspace";

const policyInput = z.strictObject({
  sharing: z.boolean(),
});

export function createRunnerPlacementBrowser(options: { db: Database; now?: () => number }) {
  const { db } = options;
  const now = options.now ?? Date.now;
  const json = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { "cache-control": "no-store" } });
  function member(principal: WorkspacePrincipal) {
    const current = workspaceMember(db, principal.workspaceId, principal.userId);
    if (!current?.active) throw new Error("Workspace access is unavailable.");
    return current;
  }
  /** The runner's label for a model it ran, such as "Opus 5.5 · 1M context". */
  function modelLabel(runnerId: string, agent: string | null, model: string | null) {
    if (!model) return null;
    const row = db
      .query<{ resultJson: string }, [string, string]>(
        "SELECT result_json AS resultJson FROM agent_model_catalog WHERE runner_id=? AND agent=? AND model='' ORDER BY updated_at DESC LIMIT 1",
      )
      .get(runnerId, agent ?? "");
    const parsed = row ? RunnerHealthResultSchema.safeParse(JSON.parse(row.resultJson)) : null;
    const models = parsed?.success ? (parsed.data.models ?? []) : [];
    const entries = models.some((entry) => entry.id === model)
      ? models
      : [...models, { id: model, name: model }];
    return labelModels(entries).find((entry) => entry.id === model)!.name;
  }
  async function body(request: Request) {
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
      throw new Error("Use a JSON request.");
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Runner settings are required.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 4096) {
          await reader.cancel();
          throw new Error("Runner settings are too large.");
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  }
  return async function browser(
    request: Request,
    principal: WorkspacePrincipal,
  ): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    const match = /^\/api\/runners\/([0-9A-HJKMNP-TV-Z]{26})\/policy$/.exec(path);
    if (!match && path !== "/api/runners/usage") return null;
    try {
      const current = member(principal);
      if (path === "/api/runners/usage") {
        if (request.method !== "GET") return json({ error: "Use GET." }, 405);
        const all = ["owner", "admin"].includes(current.role);
        const host = new URL(request.url).searchParams.get("runner") ?? "";
        return json({
          usage: db
            .query<
              { runnerId: string; agent: string | null; resolvedModel: string | null },
              [string, number, string, string, string]
            >(`SELECT u.command_id AS commandId,u.runner_id AS runnerId,r.name AS runnerName,
          u.owner_user_id AS ownerUserId,u.item_id AS itemId,u.run_id AS runId,u.agent,u.model,
          u.resolved_model AS resolvedModel,u.role,u.purpose,
          u.started_at AS startedAt,u.ended_at AS endedAt,u.outcome,u.output_bytes AS outputBytes
          FROM runner_execution_usage u JOIN runner r ON r.id=u.runner_id WHERE r.workspace_id=?
          AND (?=1 OR u.owner_user_id=?) AND (?='' OR u.runner_id=?)
          ORDER BY u.started_at DESC,u.rowid DESC LIMIT 100`)
            .all(principal.workspaceId, all ? 1 : 0, principal.userId, host, host)
            .map((row) => ({
              ...row,
              modelLabel: modelLabel(row.runnerId, row.agent, row.resolvedModel),
            })),
        });
      }
      const runnerId = match![1]!;
      function runner() {
        const row = db
          .query<{ ownerId: string; revokedAt: number | null }, [string, string]>(
            "SELECT owner_user_id AS ownerId,revoked_at AS revokedAt FROM runner WHERE id=? AND workspace_id=?",
          )
          .get(runnerId, principal.workspaceId);
        if (!row) throw new Error("Runner is unavailable.");
        return row;
      }
      const identity = runner();
      if (request.method === "GET")
        return json({
          ownerUserId: identity.ownerId,
          ...db
            .query<{ sharing: number }, [string]>(
              "SELECT sharing FROM runner_policy WHERE runner_id=?",
            )
            .get(runnerId),
          agents: db
            .query(`SELECT agent,ready,auth_expired AS authExpired,quota_state AS quotaState,
        resets_at AS resetsAt,cooldown_until AS cooldownUntil,resolved_model AS resolvedModel FROM runner_agent_policy WHERE runner_id=? ORDER BY agent`)
            .all(runnerId),
        });
      if (request.method !== "POST") return json({ error: "Use GET or POST." }, 405);
      const input = policyInput.parse(await body(request));
      immediate(db, () => {
        const actor = member(principal);
        const host = runner();
        if (
          actor.role === "observer" ||
          host.ownerId !== principal.userId ||
          host.revokedAt !== null
        )
          throw new Error("Only the active host owner can change its sharing settings.");
        db.run(
          `INSERT INTO runner_policy(runner_id,sharing) VALUES(?,?) ON CONFLICT(runner_id)
          DO UPDATE SET sharing=excluded.sharing`,
          [runnerId, input.sharing ? 1 : 0],
        );
        auditWorkspaceAccess(db, {
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          action: "runner.policy.updated",
          subject: runnerId,
          now: now(),
        });
      });
      return json({ ok: true });
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return json({ error: "Choose a valid sharing setting." }, 400);
      return json(
        { error: error instanceof Error ? error.message : "Runner settings are unavailable." },
        403,
      );
    }
  };
}
