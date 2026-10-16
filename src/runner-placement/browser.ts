import type { Database } from "bun:sqlite";
import { z } from "zod";
import { auditWorkspaceAccess, immediate, workspaceMember } from "../db";
import type { WorkspacePrincipal } from "../workspace";

const policyInput = z.strictObject({
  agent: z.enum(["claude", "codex", "grok"]),
  seat: z.enum(["unknown", "personal", "organization", "api"]),
  sharing: z.boolean(),
});
const workspaceInput = z.strictObject({
  personalOrganizationHost: z.boolean(),
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
  function recent(principal: WorkspacePrincipal) {
    if (now() < principal.authenticatedAt || now() - principal.authenticatedAt > 900_000)
      throw new Error("Sign in again to update runner settings.");
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
    if (!match && path !== "/api/runners/policy" && path !== "/api/runners/usage") return null;
    try {
      const current = member(principal);
      if (path === "/api/runners/usage") {
        if (request.method !== "GET") return json({ error: "Use GET." }, 405);
        const all = ["owner", "admin"].includes(current.role);
        return json({
          usage: db
            .query(`SELECT u.command_id AS commandId,u.runner_id AS runnerId,r.name AS runnerName,
          u.owner_user_id AS ownerUserId,u.agent,u.model,u.resolved_model AS resolvedModel,u.seat,u.role,u.purpose,
          u.started_at AS startedAt,u.ended_at AS endedAt,u.outcome,u.output_bytes AS outputBytes
          FROM runner_execution_usage u JOIN runner r ON r.id=u.runner_id WHERE r.workspace_id=?
          AND (?=1 OR u.owner_user_id=?) ORDER BY u.started_at DESC,u.rowid DESC LIMIT 100`)
            .all(principal.workspaceId, all ? 1 : 0, principal.userId),
        });
      }
      if (path === "/api/runners/policy") {
        if (request.method === "GET") {
          const row = db
            .query<{ personalOrganizationHost: number }, [string]>(
              "SELECT personal_organization_host AS personalOrganizationHost FROM workspace_runner_policy WHERE workspace_id=?",
            )
            .get(principal.workspaceId);
          return json({
            personalOrganizationHost: row?.personalOrganizationHost === 1,
          });
        }
        if (request.method !== "POST") return json({ error: "Use GET or POST." }, 405);
        const input = workspaceInput.parse(await body(request));
        immediate(db, () => {
          if (member(principal).role !== "owner")
            throw new Error("Only the workspace owner can update workspace runner permission.");
          recent(principal);
          db.run(
            `INSERT INTO workspace_runner_policy(workspace_id,personal_organization_host) VALUES(?,?)
            ON CONFLICT(workspace_id) DO UPDATE SET personal_organization_host=excluded.personal_organization_host`,
            [principal.workspaceId, input.personalOrganizationHost ? 1 : 0],
          );
          auditWorkspaceAccess(db, {
            workspaceId: principal.workspaceId,
            userId: principal.userId,
            action: "runner.workspace_policy.updated",
            subject: principal.workspaceId,
            now: now(),
          });
        });
        return json({ ok: true });
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
            .query(`SELECT agent,seat,ready,auth_expired AS authExpired,quota_state AS quotaState,
        resets_at AS resetsAt,cooldown_until AS cooldownUntil,resolved_model AS resolvedModel FROM runner_agent_policy WHERE runner_id=? ORDER BY agent`)
            .all(runnerId),
        });
      if (request.method !== "POST") return json({ error: "Use GET or POST." }, 405);
      const input = policyInput.parse(await body(request));
      immediate(db, () => {
        const actor = member(principal);
        const host = runner();
        recent(principal);
        if (
          actor.role === "observer" ||
          host.ownerId !== principal.userId ||
          host.revokedAt !== null
        )
          throw new Error("Only the active host owner can change its sharing settings.");
        if (input.sharing && !["organization", "api"].includes(input.seat))
          throw new Error("Sharing requires an organization or API account.");
        if (
          input.seat === "personal" &&
          !db
            .query(
              "SELECT 1 FROM workspace_runner_policy WHERE workspace_id=? AND personal_organization_host=1",
            )
            .get(principal.workspaceId)
        )
          throw new Error("Personal accounts require workspace owner permission.");
        db.run(
          `INSERT INTO runner_policy(runner_id,sharing) VALUES(?,?) ON CONFLICT(runner_id)
          DO UPDATE SET sharing=excluded.sharing`,
          [runnerId, input.sharing ? 1 : 0],
        );
        db.run(
          `INSERT INTO runner_agent_policy(runner_id,agent,seat) VALUES(?,?,?) ON CONFLICT(runner_id,agent) DO UPDATE SET seat=excluded.seat`,
          [runnerId, input.agent, input.seat],
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
        return json({ error: "Choose a valid agent and account type." }, 400);
      return json(
        { error: error instanceof Error ? error.message : "Runner settings are unavailable." },
        403,
      );
    }
  };
}
