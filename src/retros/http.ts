import type { Database } from "bun:sqlite";
import {
  workspaceMemberUsable,
  auditWorkspaceAccess,
  listWorkspaceRepositoryNames,
  workspaceMember,
} from "../db";
import { journalCaught } from "../journal";
import type { AgentModelCatalog } from "../runner-models";
import { isWorkspaceAdmin, type WorkspacePrincipal } from "../workspace";
import { readRetroSettings, saveRetroSettings } from "./settings";

export const RETRO_SETTINGS_PATH = "/api/retros/settings";
const BODY_LIMIT = 64 * 1024;

export type RetroCatalog = (principal: WorkspacePrincipal) => readonly AgentModelCatalog[] | null;

export function createFakeRetroCatalog(catalogs: readonly AgentModelCatalog[] | null) {
  const calls: { workspaceId: string; userId: string }[] = [];
  const read: RetroCatalog = (principal) => {
    calls.push({ workspaceId: principal.workspaceId, userId: principal.userId });
    return catalogs;
  };
  return { read, calls };
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

export function createRetroSettingsHttp(options: {
  db: Database;
  catalog: RetroCatalog;
  now?: () => number;
}) {
  const { db } = options;
  const now = options.now ?? Date.now;
  const audit = (principal: WorkspacePrincipal, action: string, subject: string) =>
    auditWorkspaceAccess(db, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action,
      subject,
      now: now(),
    });
  return async (request: Request, principal: WorkspacePrincipal): Promise<Response | null> => {
    if (new URL(request.url).pathname !== RETRO_SETTINGS_PATH) return null;
    if (!workspaceMemberUsable(workspaceMember(db, principal.workspaceId, principal.userId)))
      return json({ error: "Workspace access is unavailable." }, 403);
    const accessibleRepositories = listWorkspaceRepositoryNames(db, principal.workspaceId);
    const view = () =>
      readRetroSettings(db, { workspaceId: principal.workspaceId, accessibleRepositories });
    if (request.method === "GET")
      return json({ ...view(), canEdit: isWorkspaceAdmin(principal.role) });
    if (request.method !== "PUT") return json({ error: "Use GET or PUT." }, 405);
    if (!isWorkspaceAdmin(principal.role)) {
      audit(principal, "access.denied", RETRO_SETTINGS_PATH);
      return json({ error: "Only workspace admins can change retro settings." }, 403);
    }
    let body: unknown;
    try {
      const text = await request.text();
      if (text.length > BODY_LIMIT) return json({ error: "Send at most 64 KiB." }, 413);
      body = JSON.parse(text);
    } catch (error) {
      journalCaught(error, "retros.settings.readJson", null);
      return json({ error: "Expected a JSON body." }, 400);
    }
    const record =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    if (!Number.isInteger(record.expectedRevision) || (record.expectedRevision as number) < 0)
      return json({ error: "Send expectedRevision, the revision this draft started from." }, 400);
    let catalogs: readonly AgentModelCatalog[] | null;
    try {
      catalogs = options.catalog(principal);
    } catch (error) {
      journalCaught(error, "retros.settings.catalog", null);
      catalogs = null;
    }
    const result = saveRetroSettings(db, {
      workspaceId: principal.workspaceId,
      actorId: principal.userId,
      expectedRevision: record.expectedRevision as number,
      draft: record.settings,
      catalogs,
      accessibleRepositories,
      now: now(),
    });
    if (result.ok) {
      audit(principal, "settings.retros.saved", `revision ${result.view.revision}`);
      return json({ ...result.view, canEdit: true });
    }
    if (result.reason === "conflict")
      return json(
        {
          error: "Someone saved retro settings after you started editing. Your draft is unchanged.",
          reason: result.reason,
          current: { ...result.current, canEdit: true },
          draft: result.draft,
        },
        409,
      );
    return json(
      {
        error: result.problems.map((problem) => problem.message).join(" "),
        reason: result.reason,
        problems: result.problems,
        draft: result.draft,
      },
      result.reason === "catalog_unavailable" ? 503 : 400,
    );
  };
}
