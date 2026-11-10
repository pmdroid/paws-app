import {
  auditWorkspaceAccessSteps,
  latestModelCatalogSteps,
  runnerAgentPoliciesSteps,
  runnerSharingSteps,
  runnerUsageListSteps,
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
  async function modelLabel(runnerId: string, agent: string | null, model: string | null) {
    if (!model) return null;
    const resultJson = await store.run((q) => latestModelCatalogSteps(q, runnerId, agent ?? ""));
    const parsed = resultJson ? RunnerHealthResultSchema.safeParse(JSON.parse(resultJson)) : null;
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
        const rows = await store.run((q) =>
          runnerUsageListSteps(q, {
            workspaceId: principal.workspaceId,
            all,
            userId: principal.userId,
            runnerId: host,
          }),
        );
        const usage = [];
        for (const row of rows)
          usage.push({
            ...row,
            accountNamed: row.accountNamed === null ? null : row.accountNamed === 1,
            modelLabel: await modelLabel(row.runnerId, row.agent, row.resolvedModel),
            preferredBecause: row.placementReason
              ? (PREFERRED_BECAUSE[row.placementReason] ?? null)
              : null,
          });
        return json({ usage });
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
          ...(await store.run((q) => runnerSharingSteps(q, runnerId))),
          agents: await store.run((q) => runnerAgentPoliciesSteps(q, runnerId)),
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
