import type { Database } from "bun:sqlite";
import { auditWorkspaceAccess, listWorkspaceRepositoryNames, workspaceMember } from "../db";
import { journalCaught } from "../journal";
import type { AgentModelCatalog } from "../runner-models";
import { isWorkspaceAdmin, type WorkspacePrincipal } from "../workspace";
import type { RetroCatalog } from "./http";
import type { RetroScheduler } from "./schedule";
import { readRetroSettings, saveRetroSettings } from "./settings";

export const RETRO_SCHEDULE_PATH = "/api/retros/schedule";
export const RETRO_RUNS_PATH = "/api/retros/runs";
const BODY_LIMIT = 16 * 1024;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const REQUEST_STATUS = {
  no_settings: 409,
  no_accessible_repository: 409,
  unsupported: 409,
  clock_behind: 409,
  catalog_unavailable: 503,
  busy: 409,
  stale: 409,
} as const;

export function createRetroScheduleHttp(options: {
  db: Database;
  scheduler: RetroScheduler;
  catalog: RetroCatalog;
  now?: () => number;
}) {
  const { db, scheduler } = options;
  const now = options.now ?? Date.now;
  const audit = (principal: WorkspacePrincipal, action: string, subject: string) =>
    auditWorkspaceAccess(db, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action,
      subject,
      now: now(),
    });
  const view = (principal: WorkspacePrincipal) => ({
    ...scheduler.status(principal.workspaceId),
    canEdit: isWorkspaceAdmin(principal.role),
    canRun: true,
  });

  async function saveSchedule(request: Request, principal: WorkspacePrincipal) {
    if (!isWorkspaceAdmin(principal.role)) {
      audit(principal, "access.denied", RETRO_SCHEDULE_PATH);
      return json({ error: "Only workspace admins can change the retro schedule." }, 403);
    }
    let body: Record<string, unknown>;
    try {
      const text = await request.text();
      if (text.length > BODY_LIMIT) return json({ error: "Send at most 16 KiB." }, 413);
      const parsed: unknown = JSON.parse(text);
      body =
        typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch (error) {
      journalCaught(error, "retros.schedule.readJson", null);
      return json({ error: "Expected a JSON body." }, 400);
    }
    if (!Number.isInteger(body.expectedRevision) || (body.expectedRevision as number) < 0)
      return json({ error: "Send expectedRevision, the revision this change started from." }, 400);
    const accessibleRepositories = listWorkspaceRepositoryNames(db, principal.workspaceId);
    const current = readRetroSettings(db, {
      workspaceId: principal.workspaceId,
      accessibleRepositories,
    });
    if (!current.saved)
      return json(
        {
          error: "Save retro settings before changing the schedule.",
          reason: "no_settings",
          proposed: current.settings.schedule,
        },
        409,
      );
    let catalogs: readonly AgentModelCatalog[] | null;
    try {
      catalogs = options.catalog(principal);
    } catch (error) {
      journalCaught(error, "retros.schedule.catalog", null);
      catalogs = null;
    }
    const result = saveRetroSettings(db, {
      workspaceId: principal.workspaceId,
      actorId: principal.userId,
      expectedRevision: body.expectedRevision as number,
      draft: { ...current.settings, schedule: body.schedule },
      catalogs,
      accessibleRepositories,
      now: now(),
      keepSavedProfile: true,
    });
    if (result.ok) {
      audit(principal, "settings.retros.schedule.saved", `revision ${result.view.revision}`);
      return json(view(principal));
    }
    if (result.reason === "conflict")
      return json(
        {
          error:
            "Someone saved retro settings after you started editing. Your change is unchanged.",
          reason: result.reason,
          current: view(principal),
        },
        409,
      );
    return json(
      {
        error: result.problems.map((problem) => problem.message).join(" "),
        reason: result.reason,
        problems: result.problems,
      },
      result.reason === "catalog_unavailable" ? 503 : 400,
    );
  }

  function run(principal: WorkspacePrincipal) {
    const requested = scheduler.request(principal.workspaceId, principal.userId);
    if (!requested.ok) {
      audit(principal, "retros.run.refused", requested.reason);
      return json(
        { error: requested.message, reason: requested.reason, status: view(principal) },
        REQUEST_STATUS[requested.reason],
      );
    }
    audit(
      principal,
      requested.created ? "retros.run.requested" : "retros.run.joined",
      requested.retro.id,
    );
    return json(
      { retroId: requested.retro.id, created: requested.created, status: view(principal) },
      requested.created ? 202 : 200,
    );
  }

  return async (request: Request, principal: WorkspacePrincipal): Promise<Response | null> => {
    const path = new URL(request.url).pathname;
    if (path !== RETRO_SCHEDULE_PATH && path !== RETRO_RUNS_PATH) return null;
    if (!workspaceMember(db, principal.workspaceId, principal.userId)?.active)
      return json({ error: "Workspace access is unavailable." }, 403);
    if (path === RETRO_RUNS_PATH) {
      if (request.method !== "POST") return json({ error: "Use POST." }, 405);
      return run(principal);
    }
    if (request.method === "GET") return json(view(principal));
    if (request.method === "PUT") return saveSchedule(request, principal);
    return json({ error: "Use GET or PUT." }, 405);
  };
}
