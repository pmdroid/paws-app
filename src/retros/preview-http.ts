import {
  auditWorkspaceAccessSteps,
  workspaceMemberSteps,
  workspaceMemberUsable,
  type Db,
} from "../db";
import { journalCaught } from "../journal";
import type { WorkspacePrincipal } from "../workspace";
import { retroReaderAccess } from "./access";
import { previewRetroPrompt, readRetroRenderedPrompt } from "./prompt";

export const RETRO_PREVIEW_PATH = "/api/retros/preview";
const FROZEN = /^\/api\/retros\/reports\/([0-9A-Za-z]{1,64})\/settings$/;
const BODY_LIMIT = 64 * 1024;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

export function createRetroPreviewHttp(options: {
  store: Db;
  artifactRoot: string;
  now?: () => number;
}) {
  const { store, artifactRoot: root } = options;
  const now = options.now ?? Date.now;
  const denied = (principal: WorkspacePrincipal, subject: string) =>
    store.run((q) =>
      auditWorkspaceAccessSteps(q, {
        workspaceId: principal.workspaceId,
        userId: principal.userId,
        action: "access.denied",
        subject,
        now: now(),
      }),
    );

  async function preview(
    request: Request,
    principal: WorkspacePrincipal,
    sessionIds: readonly string[],
  ) {
    if (request.method !== "POST") return json({ error: "Use POST." }, 405);
    let body: Record<string, unknown>;
    try {
      const text = await request.text();
      if (text.length > BODY_LIMIT) return json({ error: "Send at most 64 KiB." }, 413);
      const parsed: unknown = JSON.parse(text);
      body =
        typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch (error) {
      journalCaught(error, "retros.preview.readJson", null);
      return json({ error: "Expected a JSON body." }, 400);
    }
    const outputLimits =
      typeof body.outputLimits === "object" && body.outputLimits !== null
        ? (body.outputLimits as Record<string, unknown>)
        : {};
    const result = await previewRetroPrompt(store, root, {
      principal,
      sessionIds,
      prompt: typeof body.prompt === "string" ? body.prompt : "",
      outputLimits,
    });
    if (result.ok)
      return json({
        text: result.text,
        sha256: result.sha256,
        label: result.label,
        source: result.source,
      });
    if (result.reason === "forbidden") await denied(principal, RETRO_PREVIEW_PATH);
    return json(
      { error: result.message, reason: result.reason },
      result.reason === "forbidden" ? 403 : 400,
    );
  }

  async function frozen(
    principal: WorkspacePrincipal,
    sessionIds: readonly string[],
    retroId: string,
  ) {
    const path = `/api/retros/reports/${retroId}/settings`;
    const access = await retroReaderAccess(store, root, principal, sessionIds, retroId);
    if (!access)
      return json({ error: "This retro is not available to you.", reason: "not_found" }, 404);
    if (!access.full) {
      await denied(principal, path);
      return json(
        {
          error: "The frozen prompt needs access to every repository this retro includes.",
          reason: "partial_access",
        },
        403,
      );
    }
    const { retro } = access;
    const rendered = await readRetroRenderedPrompt(store, root, { principal, sessionIds, retroId });
    return json({
      retroId: retro.id,
      settingsRevision: retro.settingsRevision,
      origin: retro.origin,
      createdAt: retro.createdAt,
      prompt: retro.prompt,
      agentProfile: retro.agentProfile,
      repositories: retro.repositories,
      outputLimits: retro.outputLimits,
      executionLimits: retro.executionLimits,
      renderedPrompt: rendered.ok,
    });
  }

  return async (
    request: Request,
    principal: WorkspacePrincipal,
    sessionIds: readonly string[],
  ): Promise<Response | null> => {
    const path = new URL(request.url).pathname;
    const report = FROZEN.exec(path);
    if (path !== RETRO_PREVIEW_PATH && !report) return null;
    const member = await store.run((q) =>
      workspaceMemberSteps(q, principal.workspaceId, principal.userId),
    );
    if (!workspaceMemberUsable(member)) {
      await denied(principal, path);
      return json({ error: "Workspace access is unavailable." }, 403);
    }
    if (!report) return preview(request, principal, sessionIds);
    if (request.method !== "GET") return json({ error: "Use GET." }, 405);
    return frozen(principal, sessionIds, report[1]!);
  };
}
