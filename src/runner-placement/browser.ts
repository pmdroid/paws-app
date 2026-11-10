import {
  auditWorkspaceAccessSteps,
  setRunnerAgentExtraUsageSteps,
  setRunnerSharingSteps,
  sqliteDb,
  workspaceMemberSteps,
  workspaceMemberUsable,
  workspaceRunnerHostSteps,
  type Q,
} from "../db";
import { isWorkspaceAdmin } from "../workspace";
import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { RunnerHealthResultSchema, labelModels } from "../runner-protocol";
import type { WorkspacePrincipal } from "../workspace";

const policyInput = z.strictObject({
  sharing: z.boolean(),
});
const extraUsageInput = z.strictObject({
  extraUsage: z.boolean(),
});

/** Why placement ranked the runner first, in the words the runner list shows. */
const PREFERRED_BECAUSE: Record<string, string> = {
  session_restore: "can continue the agent's session",
  extra_usage: "runs on extra usage: no runner with quota was free",
};

export function createRunnerPlacementBrowser(options: { db: Database; now?: () => number }) {
  const { db } = options;
  const store = sqliteDb(db);
  const now = options.now ?? Date.now;
  const json = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { "cache-control": "no-store" } });
  function* memberSteps(q: Q, principal: WorkspacePrincipal) {
    const current = yield* workspaceMemberSteps(q, principal.workspaceId, principal.userId);
    if (!workspaceMemberUsable(current)) throw new Error("Workspace access is unavailable.");
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
    const extra =
      /^\/api\/runners\/([0-9A-HJKMNP-TV-Z]{26})\/agents\/(claude|codex|grok|opencode)\/extra-usage$/.exec(
        path,
      );
    if (!match && !extra && path !== "/api/runners/usage") return null;
    try {
      const current = await store.run((q) => memberSteps(q, principal));
      if (path === "/api/runners/usage") {
        if (request.method !== "GET") return json({ error: "Use GET." }, 405);
        const all = isWorkspaceAdmin(current.role);
        const host = new URL(request.url).searchParams.get("runner") ?? "";
        return json({
          usage: db
            .query<
              {
                runnerId: string;
                agent: string | null;
                resolvedModel: string | null;
                placementReason: string | null;
                accountNamed: number | null;
              },
              [string, number, string, string, string]
            >(`SELECT u.command_id AS commandId,u.runner_id AS runnerId,r.name AS runnerName,
          u.owner_user_id AS ownerUserId,u.item_id AS itemId,u.run_id AS runId,u.agent,u.model,
          u.resolved_model AS resolvedModel,u.role,u.purpose,
          u.started_at AS startedAt,u.ended_at AS endedAt,u.outcome,u.output_bytes AS outputBytes,
          u.placement_reason AS placementReason,
          u.account_policy_revision AS accountPolicyRevision,u.account_fallback AS accountFallback,
          a.label AS accountLabel,c.named AS accountNamed,
          w.linear_identifier AS identifier,w.title
          FROM runner_execution_usage u JOIN runner r ON r.id=u.runner_id
          LEFT JOIN runner_command_account c ON c.command_id=u.command_id
          LEFT JOIN agent_account a ON a.id=c.account_id
          LEFT JOIN work_item w ON w.id=u.item_id WHERE r.workspace_id=?
          AND (?=1 OR u.owner_user_id=?) AND (?='' OR u.runner_id=?)
          ORDER BY u.started_at DESC,u.rowid DESC LIMIT 100`)
            .all(principal.workspaceId, all ? 1 : 0, principal.userId, host, host)
            .map((row) => ({
              ...row,
              accountNamed: row.accountNamed === null ? null : row.accountNamed === 1,
              modelLabel: modelLabel(row.runnerId, row.agent, row.resolvedModel),
              preferredBecause: row.placementReason
                ? (PREFERRED_BECAUSE[row.placementReason] ?? null)
                : null,
            })),
        });
      }
      if (extra) {
        if (request.method !== "POST") return json({ error: "Use POST." }, 405);
        const [, runnerId, agent] = extra;
        const input = extraUsageInput.parse(await body(request));
        await store.transaction(function* (q) {
          const changer = yield* memberSteps(q, principal);
          const host = yield* workspaceRunnerHostSteps(q, runnerId!, principal.workspaceId);
          if (
            !host ||
            host.revokedAt !== null ||
            (host.ownerId !== principal.userId && !isWorkspaceAdmin(changer.role))
          )
            throw new Error("Only the host owner or a workspace admin can change extra usage.");
          const at = now();
          const changed = yield* setRunnerAgentExtraUsageSteps(q, {
            runnerId: runnerId!,
            agent: agent!,
            extraUsage: input.extraUsage,
            at,
          });
          if (!changed) throw new Error("Sign the agent in on this runner first.");
          yield* auditWorkspaceAccessSteps(q, {
            workspaceId: principal.workspaceId,
            userId: principal.userId,
            action: "runner.extra_usage.updated",
            subject: `${runnerId}:${agent}`,
            now: at,
          });
        });
        return json({ ok: true });
      }
      const runnerId = match![1]!;
      function* runnerSteps(q: Q) {
        const row = yield* workspaceRunnerHostSteps(q, runnerId, principal.workspaceId);
        if (!row) throw new Error("Runner is unavailable.");
        return row;
      }
      const identity = await store.run(runnerSteps);
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
        resets_at AS resetsAt,cooldown_until AS cooldownUntil,resolved_model AS resolvedModel,
        extra_usage=1 AS extraUsage FROM runner_agent_policy WHERE runner_id=? ORDER BY agent`)
            .all(runnerId)
            .map((row) => ({
              ...(row as object),
              extraUsage: (row as { extraUsage: number }).extraUsage === 1,
            })),
        });
      if (request.method !== "POST") return json({ error: "Use GET or POST." }, 405);
      const input = policyInput.parse(await body(request));
      await store.transaction(function* (q) {
        yield* memberSteps(q, principal);
        const host = yield* runnerSteps(q);
        if (host.ownerId !== principal.userId || host.revokedAt !== null)
          throw new Error("Only the active host owner can change its sharing settings.");
        yield* setRunnerSharingSteps(q, runnerId, input.sharing);
        yield* auditWorkspaceAccessSteps(q, {
          workspaceId: principal.workspaceId,
          userId: principal.userId,
          action: "runner.policy.updated",
          subject: runnerId,
          now: now(),
        });
      });
      return json({ ok: true });
    } catch (error) {
      journalCaught(error, "browser.createRunnerPlacementBrowser.member", null);
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return json(
          {
            error: extra
              ? "Choose a valid extra usage setting."
              : "Choose a valid sharing setting.",
          },
          400,
        );
      return json(
        { error: error instanceof Error ? error.message : "Runner settings are unavailable." },
        403,
      );
    }
  };
}
