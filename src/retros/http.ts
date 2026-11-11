import { existsSync } from "node:fs";
import { join } from "node:path";
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
  retroArtifact,
  workspaceMember,
  type RetroArtifactKind,
  type RetroCoverageGap,
  sqliteDb,
} from "../db";
import { improvementFollowThrough, memberRepositories } from "../improvements";
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
      return json({ ...(await view()), canEdit: isWorkspaceAdmin(principal.role) });
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
    const result = await saveRetroSettings(db, {
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

/**
 * History pages by period: newest window end first, then id. The cursor names the last retro
 * shown, so a retro added or removed meanwhile neither repeats nor skips one on the next page.
 */
function parseHistoryCursor(raw: string | null) {
  if (raw === null || raw === "") return null;
  const match = /^(\d{1,16})\.([0-9A-Za-z]{1,64})$/.exec(raw);
  return match ? { windowEnd: Number(match[1]), id: match[2]! } : undefined;
}

const missing = () =>
  json(
    { error: "This retro is not available to you. Return to the history.", reason: "not_found" },
    404,
  );

function visibleItem(access: RetroReaderAccess, evidenceIds: readonly string[]) {
  return evidenceIds.length > 0 && evidenceIds.every((id) => access.readable.has(id));
}

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

/** The agent, model and effort frozen on the retro. A null effort means the agent's default. */
const profileOf = (profile: Record<string, unknown>) => ({
  agent: text(profile.agent),
  model: text(profile.model),
  effort: text(profile.effort),
});

/** `none` when Paws never stored the file, `unavailable` when its record outlived the file. */
function artifactState(db: Database, root: string, retroId: string, kind: RetroArtifactKind) {
  const record = retroArtifact(db, retroId, kind);
  if (record === null) return "none" as const;
  return existsSync(join(root, record.fileName)) ? ("stored" as const) : ("unavailable" as const);
}

/** Expired when a source's retention ran out before collection, incomplete for any other gap. */
const evidenceState = (gaps: readonly RetroCoverageGap[]) =>
  gaps.some((gap) => gap.kind === "retention_gap")
    ? ("expired" as const)
    : gaps.length
      ? ("incomplete" as const)
      : ("complete" as const);

function historyEntry(db: Database, root: string, access: RetroReaderAccess) {
  const { retro } = access;
  const items = listRetroItems(db, retro.id).filter((item) =>
    visibleItem(access, item.evidenceIds),
  );
  const improvements = items.map((item) => ({
    item,
    improvement: getImprovement(db, item.improvementId),
  }));
  const generation = retroGenerationView(db, retro.id);
  const result = retro.result as RetroReport | null;
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
      toReview: improvements.filter(
        ({ improvement }) => improvement?.reviewState === "needs_review",
      ).length,
      links: improvements.map(({ item, improvement }) => ({
        itemId: item.itemId,
        improvementId: item.improvementId,
        reviewState: improvement?.reviewState ?? null,
        issue: improvement?.issue
          ? { identifier: improvement.issue.identifier, url: improvement.issue.url }
          : null,
      })),
    },
    ...(access.full
      ? {
          settingsRevision: retro.settingsRevision,
          profile: profileOf(retro.agentProfile),
          digest: retro.digestSha256 === null ? null : access.digest,
          patterns: result === null ? null : result.items.length,
          evidence: evidenceState(listRetroCoverageGaps(db, retro.id)),
          artifacts: {
            digest: artifactState(db, root, retro.id, "digest"),
            prompt: artifactState(db, root, retro.id, "prompt"),
            report: result === null ? ("none" as const) : ("stored" as const),
          },
        }
      : {
          settingsRevision: null,
          profile: null,
          digest: null,
          patterns: null,
          evidence: null,
          artifacts: null,
        }),
  };
}

type PromptManifest = {
  maxChars?: unknown;
  chars?: unknown;
  sessionsIncluded?: unknown;
  perSession?: {
    included?: unknown;
    countedIncluded?: unknown;
    countedOmitted?: unknown;
    contextIncluded?: unknown;
    contextOmitted?: unknown;
  }[];
};

/**
 * What the bounded prompt actually gave the agent, from the manifest frozen with the digest.
 * Null when the manifest is missing, unreadable or predates prompt coverage.
 */
function promptCoverage(db: Database, root: string, retroId: string) {
  const stored = readRetroArtifact(db, root, retroId, "manifest");
  if (!stored.ok) return null;
  let prompt: PromptManifest | undefined;
  try {
    prompt = (JSON.parse(new TextDecoder().decode(stored.bytes)) as { prompt?: PromptManifest })
      .prompt;
  } catch {
    return null;
  }
  if (!prompt || !Array.isArray(prompt.perSession)) return null;
  const sum = (key: "countedIncluded" | "countedOmitted" | "contextIncluded" | "contextOmitted") =>
    prompt.perSession!.reduce((total, entry) => total + (Number(entry[key]) || 0), 0);
  const included = prompt.perSession.filter((entry) => entry.included === true).length;
  return {
    maxChars: Number(prompt.maxChars) || null,
    sessionsIncluded: included,
    sessionsOmitted: prompt.perSession.length - included,
    countedIncluded: sum("countedIncluded"),
    countedOmitted: sum("countedOmitted"),
    contextIncluded: sum("contextIncluded"),
    contextOmitted: sum("contextOmitted"),
  };
}

/** Each visible item's follow-through as it is now, or null when it is not in the reader's inbox. */
function currentOutcomes(
  db: Database,
  root: string,
  principal: WorkspacePrincipal,
  sessionIds: readonly string[],
  access: RetroReaderAccess,
  itemIds: readonly { itemId: string; improvementId: string }[],
  now: number,
) {
  const evidence = new Map<string, ReadonlySet<string> | null>([
    [access.retro.id, access.readable],
  ]);
  const reader = {
    workspaceId: principal.workspaceId,
    repositories: memberRepositories(db, principal.workspaceId, principal.userId),
    sessionIds,
    retroEvidence: (retroId: string) => {
      if (!evidence.has(retroId))
        evidence.set(
          retroId,
          retroReaderAccess(db, root, principal, sessionIds, retroId)?.readable ?? null,
        );
      return evidence.get(retroId)!;
    },
  };
  return Object.fromEntries(
    itemIds.map(({ itemId, improvementId }) => {
      const view = improvementFollowThrough(db, reader, improvementId, now)?.followThrough;
      return [
        itemId,
        view
          ? {
              improvementId,
              attention: view.attention,
              issue: view.issue
                ? {
                    identifier: view.issue.identifier,
                    url: view.issue.url,
                    confirmedAt: view.issue.confirmedAt,
                    syncedAt: view.issue.sync?.confirmedAt ?? null,
                    fresh: view.issue.fresh,
                  }
                : null,
              implementation: { state: view.implementation.state, at: view.implementation.at },
              verification: { state: view.verification.state, at: view.verification.at },
            }
          : null,
      ];
    }),
  );
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
    if (!workspaceMemberUsable(workspaceMember(db, principal.workspaceId, principal.userId))) {
      audit(principal, "access.denied", url.pathname);
      return json({ error: "Workspace access is unavailable." }, 403);
    }
    if (request.method !== "GET") return json({ error: "Use GET." }, 405);
    if (!report) {
      const cursor = parseHistoryCursor(url.searchParams.get("cursor"));
      const limit = Number(url.searchParams.get("limit") ?? HISTORY_PAGE.size);
      if (cursor === undefined || !Number.isInteger(limit) || limit < 1)
        return json({ error: "Check the history page parameters." }, 400);
      const size = Math.min(limit, HISTORY_PAGE.max);
      const visible = (await listRetros(sqliteDb(db), principal.workspaceId)).flatMap((retro) => {
        const access = retroReaderAccess(db, root, principal, sessionIds, retro.id);
        return access &&
          (access.full ||
            listRetroItems(db, retro.id).some((item) => visibleItem(access, item.evidenceIds)))
          ? [access]
          : [];
      });
      const after =
        cursor === null
          ? visible
          : visible.filter(
              ({ retro }) =>
                retro.windowEnd < cursor.windowEnd ||
                (retro.windowEnd === cursor.windowEnd && retro.id > cursor.id),
            );
      const shown = after.slice(0, size);
      const last = shown.at(-1)?.retro;
      return json({
        retros: shown.map((access) => historyEntry(db, root, access)),
        total: visible.length,
        nextCursor:
          last !== undefined && after.length > size ? `${last.windowEnd}.${last.id}` : null,
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
    const shown = filteredReport(db, access);
    return json({
      retro: historyEntry(db, root, access),
      report: shown,
      coverageGaps: access.full ? listRetroCoverageGaps(db, retroId!) : null,
      promptCoverage: access.full ? promptCoverage(db, root, retroId!) : null,
      current: currentOutcomes(
        db,
        root,
        principal,
        sessionIds,
        access,
        (shown?.items ?? []).flatMap((item) =>
          item.improvement
            ? [{ itemId: item.itemId, improvementId: item.improvement.improvementId }]
            : [],
        ),
        now(),
      ),
    });
  };
}
