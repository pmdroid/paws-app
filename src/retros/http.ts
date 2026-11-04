import type { Database } from "bun:sqlite";
import {
  workspaceMemberUsable,
  auditWorkspaceAccess,
  listWorkspaceRepositoryNames,
  getImprovement,
  listRetroCoverageGaps,
  listRetroEvidence,
  listRetroItems,
  listRetros,
  readRetroArtifact,
  workspaceMember,
} from "../db";
import { journalCaught } from "../journal";
import type { AgentModelCatalog } from "../runner-models";
import { isWorkspaceAdmin, type WorkspacePrincipal } from "../workspace";
import { retroReaderAccess, type RetroReaderAccess } from "./access";
import { retroGenerationView } from "./dispatch";
import { readRetroRenderedPrompt } from "./prompt";
import { renderRetroReport, type RetroReport } from "./result";
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

export const RETRO_HISTORY_PATH = "/api/retros/history";
const REPORT =
  /^\/api\/retros\/reports\/([0-9A-Za-z]{1,64})(?:\/(digest|report|prompt)|\/items\/([A-Za-z0-9_.-]{1,100})\/evidence)?$/;
const HISTORY_PAGE = { size: 20, max: 50 } as const;

const missing = () =>
  json(
    { error: "This retro is not available to you. Return to the history.", reason: "not_found" },
    404,
  );

function visibleItem(access: RetroReaderAccess, evidenceIds: readonly string[]) {
  return evidenceIds.length > 0 && evidenceIds.every((id) => access.readable.has(id));
}

function historyEntry(db: Database, access: RetroReaderAccess) {
  const { retro } = access;
  const items = listRetroItems(db, retro.id).filter((item) =>
    visibleItem(access, item.evidenceIds),
  );
  const generation = retroGenerationView(db, retro.id);
  return {
    id: retro.id,
    windowStart: retro.windowStart,
    windowEnd: retro.windowEnd,
    origin: retro.origin,
    createdAt: retro.createdAt,
    publishedAt: retro.publishedAt,
    fullAccess: access.full,
    repositories: access.repositories,
    generation: access.full ? generation : { state: generation?.state ?? null },
    items: {
      visible: items.length,
      toReview: items.filter(
        (item) => getImprovement(db, item.improvementId)?.reviewState === "needs_review",
      ).length,
    },
  };
}

function filteredReport(db: Database, access: RetroReaderAccess) {
  const report = access.retro.result as RetroReport | null;
  if (report === null) return null;
  const decisions = new Map(
    listRetroItems(db, access.retro.id).map((item) => {
      const improvement = getImprovement(db, item.improvementId);
      return [
        item.itemId,
        {
          improvementId: item.improvementId,
          version: improvement?.version ?? null,
          reviewState: improvement?.reviewState ?? null,
        },
      ];
    }),
  );
  const items = report.items
    .filter((item) => access.full || visibleItem(access, item.evidenceIds))
    .map((item) => ({
      ...item,
      ...(access.full ? {} : { priorWork: [] }),
      improvement: decisions.get(item.itemId) ?? null,
    }));
  if (access.full) return { ...report, items, filtered: false };
  const shown = new Set(access.repositories);
  return {
    version: report.version,
    retroId: report.retroId,
    generation: report.generation,
    windows: report.windows.filter((window) => shown.has(window.repository.toLowerCase())),
    items,
    workedWell: report.workedWell.filter((entry) => visibleItem(access, entry.evidenceIds)),
    notes: report.notes,
    filtered: true,
  };
}

export function createRetroReviewHttp(options: {
  db: Database;
  artifactRoot: string;
  now?: () => number;
}) {
  const { db, artifactRoot: root } = options;
  const now = options.now ?? Date.now;
  const audit = (principal: WorkspacePrincipal, action: string, subject: string) =>
    auditWorkspaceAccess(db, {
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      action,
      subject,
      now: now(),
    });
  const download = (body: Uint8Array | string, type: string, name: string) =>
    new Response(body, {
      headers: {
        "content-type": type,
        "content-disposition": `attachment; filename="${name}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });

  return async (
    request: Request,
    principal: WorkspacePrincipal,
    sessionIds: readonly string[],
  ): Promise<Response | null> => {
    const url = new URL(request.url);
    const report = REPORT.exec(url.pathname);
    if (url.pathname !== RETRO_HISTORY_PATH && !report) return null;
    if (!workspaceMember(db, principal.workspaceId, principal.userId)?.active) {
      audit(principal, "access.denied", url.pathname);
      return json({ error: "Workspace access is unavailable." }, 403);
    }
    if (request.method !== "GET") return json({ error: "Use GET." }, 405);
    if (!report) {
      const cursor = Number(url.searchParams.get("cursor") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? HISTORY_PAGE.size);
      if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1)
        return json({ error: "Check the history page parameters." }, 400);
      const size = Math.min(limit, HISTORY_PAGE.max);
      const visible = listRetros(db, principal.workspaceId).flatMap((retro) => {
        const access = retroReaderAccess(db, root, principal, sessionIds, retro.id);
        return access &&
          (access.full ||
            listRetroItems(db, retro.id).some((item) => visibleItem(access, item.evidenceIds)))
          ? [access]
          : [];
      });
      return json({
        retros: visible.slice(cursor, cursor + size).map((access) => historyEntry(db, access)),
        total: visible.length,
        nextCursor: cursor + size < visible.length ? String(cursor + size) : null,
      });
    }
    const [, retroId, file, itemId] = report;
    const access = retroReaderAccess(db, root, principal, sessionIds, retroId!);
    if (
      !access ||
      (!access.full &&
        !listRetroItems(db, retroId!).some((item) => visibleItem(access, item.evidenceIds)))
    )
      return missing();
    if (file !== undefined) {
      if (!access.full) {
        audit(principal, "access.denied", url.pathname);
        return json(
          {
            error: "Downloading the full retro needs access to every repository it includes.",
            reason: "partial_access",
          },
          403,
        );
      }
      if (file === "digest") {
        const stored = readRetroArtifact(db, root, retroId!, "digest");
        if (!stored.ok) return missing();
        audit(principal, "retros.digest.downloaded", retroId!);
        return download(stored.bytes, "application/json", `retro-${retroId}-digest.json`);
      }
      if (file === "prompt") {
        const prompt = readRetroRenderedPrompt(db, root, {
          principal,
          sessionIds,
          retroId: retroId!,
        });
        if (!prompt.ok) return missing();
        audit(principal, "retros.prompt.downloaded", retroId!);
        return download(prompt.prompt, "text/plain; charset=utf-8", `retro-${retroId}-prompt.txt`);
      }
      const result = access.retro.result as RetroReport | null;
      if (result === null) return missing();
      audit(principal, "retros.report.downloaded", retroId!);
      return download(
        renderRetroReport(result),
        "text/markdown; charset=utf-8",
        `retro-${retroId}-report.md`,
      );
    }
    if (itemId !== undefined) {
      const item = listRetroItems(db, retroId!).find((entry) => entry.itemId === itemId);
      if (!item || (!access.full && !visibleItem(access, item.evidenceIds)))
        return json(
          { error: "This retro item is not available to you.", reason: "not_found" },
          404,
        );
      const saved = new Map(
        listRetroEvidence(db, retroId!).map((entry) => [entry.evidenceId, entry]),
      );
      return json({
        retroId,
        itemId,
        improvementId: item.improvementId,
        evidence: item.evidenceIds.flatMap((id) => {
          const entry = saved.get(id);
          return entry
            ? [{ ...entry, identifier: access.sources.get(id)?.identifier ?? null }]
            : [];
        }),
      });
    }
    return json({
      retro: historyEntry(db, access),
      report: filteredReport(db, access),
      coverageGaps: access.full ? listRetroCoverageGaps(db, retroId!) : null,
    });
  };
}
