import type {
  EvidenceKind,
  EvidenceListResponse,
  EvidenceMetadataResponse,
  StatusEvidence,
  StatusRun,
} from "../contract";

/** An issue's runs and the evidence they published. */
export type RunEvidenceSource = {
  runs: readonly StatusRun[];
  evidence?: readonly StatusEvidence[];
};
import { parseEngineUrl } from "./format";
import { checkHash } from "./closeout";
import { esc } from "./format";
import { routeHref } from "./route";

/** What the browser learned from the loaded file. The store keeps neither. */
export interface MediaInfo {
  durationMs?: number;
  width?: number;
  height?: number;
}

export type EvidenceFilter = "all" | "video" | "image";

export const EVIDENCE_FILTERS: readonly { id: EvidenceFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "video", label: "Videos" },
  { id: "image", label: "Images" },
];

export function runEvidence(data: RunEvidenceSource, runId: string): StatusEvidence[] {
  const attempts = data.runs.find((run) => run.id === runId)?.attempts ?? [runId];
  return (data.evidence ?? []).filter((entry) => attempts.includes(entry.runId));
}

export type EvidenceVersions = { latest: StatusEvidence; earlier: StatusEvidence[] };

export function evidenceVersions(list: readonly StatusEvidence[]): EvidenceVersions[] {
  const pieces = new Map<string, StatusEvidence[]>();
  for (const entry of [...list].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))) {
    const key = JSON.stringify([entry.checkId, entry.displayName]);
    const copies = pieces.get(key) ?? [];
    pieces.set(key, [...copies, entry]);
  }
  return [...pieces.values()].map((copies) => ({
    latest: copies.at(-1)!,
    earlier: copies.slice(0, -1).reverse(),
  }));
}

export function filterEvidence(
  list: readonly StatusEvidence[],
  filter: EvidenceFilter,
): StatusEvidence[] {
  return filter === "all" ? [...list] : list.filter((entry) => entry.kind === filter);
}

/** `GET /api/evidence/<id>` on the engine that served the page. */
export function evidenceFileUrl(id: string, engineUrl: string | null): string {
  const path = `/api/evidence/${encodeURIComponent(id)}`;
  const engine = parseEngineUrl(engineUrl ?? "");
  return engine === null ? path : new URL(path, engine).href;
}

export function evidencePageHref(id: string): string {
  return routeHref({ view: "evidence", id });
}

/** The issue page, opened on the check that published the evidence. */
export function closeoutOutputHref(evidence: StatusEvidence): string {
  return `${routeHref({ view: "issues", id: evidence.itemId })}${checkHash(evidence.attempt, evidence.checkId)}`;
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function timeLabel(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** Duration of a video or dimensions of an image, once the browser has read it. */
export function measureLabel(kind: EvidenceKind, info: MediaInfo | undefined): string {
  if (kind === "video") return info?.durationMs !== undefined ? timeLabel(info.durationMs) : "";
  return info?.width && info.height ? `${info.width}×${info.height}` : "";
}

export function kindLabel(kind: EvidenceKind): string {
  return kind === "video" ? "Video" : "Image";
}

/** "Video · 0:42", or just "Video" until the browser has read the file. */
export function mediaSummary(kind: EvidenceKind, info: MediaInfo | undefined): string {
  const measure = measureLabel(kind, info);
  return measure ? `${kindLabel(kind)} · ${measure}` : kindLabel(kind);
}

/** The media element of a thumbnail. Images carry their display name as alt text. */
export function thumbnailMedia(evidence: StatusEvidence, engineUrl: string | null): string {
  const src = esc(evidenceFileUrl(evidence.id, engineUrl));
  const fit = "block h-full w-full object-cover";
  if (evidence.kind === "image")
    return `<img src="${src}" alt="${esc(evidence.displayName)}" loading="lazy" decoding="async" class="${fit}" data-evidence-media="${esc(evidence.id)}" />`;
  return `<video src="${src}#t=0.1" preload="metadata" muted playsinline tabindex="-1" aria-hidden="true" class="${fit}" data-evidence-media="${esc(evidence.id)}"></video>`;
}

/** The run page placeholder. A run without evidence has no Evidence section at all. */
export function evidenceSlot(data: RunEvidenceSource, runId: string): string {
  return runEvidence(data, runId).length
    ? `<div id="evidence-gallery" data-run="${esc(runId)}"></div>`
    : "";
}

export function renderEvidenceGallery(
  list: EvidenceListResponse,
  info: ReadonlyMap<string, MediaInfo>,
  engineUrl: string | null,
): string {
  const heading = '<header class="run-heading"><h1>Evidence</h1></header>';
  if (list.evidence.length === 0)
    return `${heading}<section class="card" aria-label="Evidence"><p class="muted">No evidence from the issues Paws lists.</p></section>`;
  const entries = [...list.evidence].reverse();
  return `${heading}<section class="card" aria-label="Evidence"><ul class="evidence-more">${entries
    .map(
      (entry) =>
        `<li><a class="evidence-thumb" href="${esc(evidencePageHref(entry.id))}" aria-label="${esc(`${kindLabel(entry.kind)} ${entry.displayName}`)}">${thumbnailMedia(entry, engineUrl)}</a><div class="row"><a class="lin-id" href="${esc(routeHref({ view: "issues", id: entry.itemId }))}">${esc(entry.itemId)}</a><a class="tag" href="${esc(closeoutOutputHref(entry))}">${esc(entry.checkId)}</a></div><div class="muted" data-evidence-measure="${esc(entry.id)}" data-evidence-kind="${entry.kind}">${esc(mediaSummary(entry.kind, info.get(entry.id)))}</div></li>`,
    )
    .join("")}</ul></section>`;
}

export function renderEvidencePage(
  page: EvidenceMetadataResponse | null,
  info: ReadonlyMap<string, MediaInfo>,
  engineUrl: string | null,
): string {
  if (page === null) return noEvidenceAccess();
  const evidence = page.evidence;
  const file = evidenceFileUrl(evidence.id, engineUrl);
  const measure = measureLabel(evidence.kind, info.get(evidence.id));
  const others = page.related.filter((entry) => entry.id !== evidence.id);
  const issue = `<a class="lin-id" href="${esc(routeHref({ view: "issues", id: evidence.itemId }))}">${esc(evidence.itemId)}</a>`;
  const more = others.length
    ? `<ul class="flex flex-wrap gap-2">${others
        .map(
          (entry) =>
            `<li><a class="tag" href="${esc(evidencePageHref(entry.id))}" aria-label="${esc(`${kindLabel(entry.kind)} ${entry.displayName}`)}">${esc(entry.displayName)}</a></li>`,
        )
        .join("")}</ul>`
    : '<p class="muted">No other evidence from this issue.</p>';
  const facts = [
    new Date(evidence.publishedAt).toLocaleString(),
    evidence.mediaType,
    sizeLabel(evidence.sizeBytes),
    ...(measure ? [measure] : []),
  ];
  return `<header class="run-heading"><p class="evidence-context font-mono text-xs text-muted-foreground">${issue} · Closeout attempt ${evidence.attempt} · check <span class="text-foreground">${esc(evidence.checkId)}</span></p><h1>${esc(evidence.displayName)}</h1><p class="muted">${esc(evidence.publisher)} published it from ${esc(page.project.repo)} at ${esc(evidence.headCommit.slice(0, 7))}. Anyone signed in to Paws with access to ${esc(page.project.repo)} sees it; it is never uploaded to Linear.</p></header>
    <div class="aspect-video w-full min-w-0 overflow-hidden rounded-md border border-border bg-card [&_[data-evidence-media]]:size-full [&_[data-evidence-media]]:rounded-none [&_[data-evidence-media]]:border-0 [&_[data-evidence-media]]:bg-transparent [&_img]:size-full [&_img]:max-h-full [&_img]:object-contain [&_.video-js]:!size-full [&_.video-js]:!pt-0">
      <div id="evidence-player" data-evidence="${esc(evidence.id)}" class="size-full"></div>
    </div>
    <div class="flex flex-wrap items-center justify-between gap-3"><span class="font-mono text-xs text-muted-foreground">${facts.map(esc).join(" · ")}</span><div class="row"><button type="button" data-action="evidence-copy" data-evidence="${esc(evidence.id)}">Copy link</button><a class="btn" href="${esc(file)}" download="${esc(evidence.displayName)}">Download</a><a class="btn" href="${esc(closeoutOutputHref(evidence))}">Closeout output</a></div></div>
    <section class="flex flex-col gap-2" aria-label="More from this issue"><h3>More from this issue</h3>${more}</section>`;
}

/**
 * Missing and forbidden look the same, so the page names no issue, repository or file.
 */
export function noEvidenceAccess(): string {
  return `<h1 class="sr-only">Evidence</h1><section class="card" aria-label="No access"><h2>You don't have access to this evidence</h2><p class="muted">Ask a workspace admin for access to the repository, or sign in with another account. Then open the link again.</p><div class="row"><a class="btn" href="${esc(routeHref({ view: "settings", page: "account" }))}">Switch account</a><a class="btn" href="${esc(routeHref({ view: "overview" }))}">Back to Overview</a></div></section>`;
}
