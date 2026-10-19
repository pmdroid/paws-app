import type { EvidenceKind, StatusEvidence, StatusSnapshot } from "../contract";
import { parseEngineUrl } from "../endpoint";
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

export function runEvidence(snapshot: StatusSnapshot, runId: string): StatusEvidence[] {
  return (snapshot.evidence ?? []).filter((entry) => entry.runId === runId);
}

export function filterEvidence(
  list: readonly StatusEvidence[],
  filter: EvidenceFilter,
): StatusEvidence[] {
  return filter === "all" ? [...list] : list.filter((entry) => entry.kind === filter);
}

/** `GET /api/evidence/<id>` on the engine that served the snapshot. */
export function evidenceFileUrl(id: string, engineUrl: string | null): string {
  const path = `/api/evidence/${encodeURIComponent(id)}`;
  const engine = parseEngineUrl(engineUrl ?? "");
  return engine === null ? path : new URL(path, engine).href;
}

export function evidencePageHref(id: string): string {
  return routeHref({ view: "evidence", id });
}

/** The run page, opened on the check that published the evidence. */
export function closeoutOutputHref(evidence: StatusEvidence): string {
  return `${routeHref({ view: "runs", id: evidence.runId })}${checkHash(evidence.attempt, evidence.checkId)}`;
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
export function evidenceSlot(snapshot: StatusSnapshot, runId: string): string {
  return runEvidence(snapshot, runId).length
    ? `<div id="evidence-gallery" data-run="${esc(runId)}" data-repo="${esc(snapshot.project.repo)}"></div>`
    : "";
}

export function renderEvidencePage(
  snapshot: StatusSnapshot,
  id: string | null,
  info: ReadonlyMap<string, MediaInfo>,
  engineUrl: string | null,
): string {
  const evidence = id === null ? undefined : snapshot.evidence?.find((entry) => entry.id === id);
  if (!evidence) return noEvidenceAccess();
  const item = snapshot.items.find((entry) => entry.id === evidence.itemId);
  const file = evidenceFileUrl(evidence.id, engineUrl);
  const measure = measureLabel(evidence.kind, info.get(evidence.id));
  const others = runEvidence(snapshot, evidence.runId).filter((entry) => entry.id !== evidence.id);
  const issue = `<a class="lin-id" href="${esc(routeHref({ view: "issues", id: evidence.itemId }))}">${esc(evidence.itemId)}</a>`;
  const repo = snapshot.project.repo;
  const linear = item?.links.find((link) => link.label === "Linear");
  const more = others.length
    ? `<ul class="evidence-more">${others
        .map(
          (entry) =>
            `<li><a class="evidence-thumb" href="${esc(evidencePageHref(entry.id))}" aria-label="${esc(`${kindLabel(entry.kind)} ${entry.displayName}`)}">${thumbnailMedia(entry, engineUrl)}</a></li>`,
        )
        .join("")}</ul>`
    : '<p class="muted">No other evidence from this run.</p>';
  return `<h1 class="sr-only">Evidence</h1>
    <nav class="crumbs" aria-label="Breadcrumb"><span>Evidence</span><span aria-hidden="true">/</span>${issue}<span aria-hidden="true">/</span><span class="crumb-run" aria-current="page">${esc(evidence.id)}</span></nav>
    <header class="run-head">
      <div class="run-tags">${issue}<span class="tag">${esc(evidence.checkId)}</span><span class="run-where">${esc(repo)} · head ${esc(evidence.headCommit.slice(0, 7))}</span></div>
      <h2 class="run-title">${esc(evidence.displayName)}</h2>
      <p class="muted">${esc(`Opened from a link in Linear. Anyone signed in to Paws with access to ${repo} sees this page.`)}</p>
    </header>
    <div class="split"><div>
      <div id="evidence-player" data-evidence="${esc(evidence.id)}"></div>
    </div>
    <div class="col">
      <div class="card"><div class="col">
        <div class="row"><button type="button" class="primary sm" data-action="evidence-copy" data-evidence="${esc(evidence.id)}">Copy link</button><a class="btn sm" href="${esc(file)}" download="${esc(evidence.displayName)}">Download</a></div>
        <div class="kv">
          <span class="k">Run</span><a class="mono" href="${esc(routeHref({ view: "runs", id: evidence.runId }))}">${esc(evidence.runId)}</a>
          <span class="k">Check</span><span class="mono">${esc(evidence.checkId)} · attempt ${evidence.attempt}</span>
          <span class="k">Published</span><span>${esc(`${evidence.publisher} · ${new Date(evidence.publishedAt).toLocaleString()}`)}</span>
          <span class="k">File</span><span>${esc([evidence.mediaType.replace(/^\w+\//, ""), sizeLabel(evidence.sizeBytes), measure].filter(Boolean).join(" · "))}</span>
          <span class="k">Head</span><span class="mono" title="${esc(evidence.headCommit)}">${esc(evidence.headCommit.slice(0, 12))}</span>
        </div>
        <p class="muted">Stored on this Paws host, never uploaded to Linear.</p>
      </div></div>
      <section class="card" aria-label="More from this run"><div class="col">
        <h3>More from this run</h3>
        ${more}
        <a href="${esc(closeoutOutputHref(evidence))}">Closeout output · ${esc(evidence.checkId)}</a>
        ${linear ? `<a href="${esc(linear.href)}" target="_blank" rel="noopener">${esc(evidence.itemId)} in Linear</a>` : ""}
      </div></section>
    </div></div>`;
}

/**
 * Missing and forbidden look the same, so the page names no issue, repository or file.
 */
export function noEvidenceAccess(): string {
  return `<h1 class="sr-only">Evidence</h1><section class="card no-access" aria-label="No access"><div class="col"><span class="no-access-mark" aria-hidden="true">🔒</span><h2>You can't open this evidence</h2><p class="muted">It belongs to a repository your Paws workspace membership does not include, or it was removed. Ask a workspace owner for access to the repository, then open the link again.</p><div class="row"><a class="btn" href="${esc(routeHref({ view: "overview" }))}">Back to Overview</a></div></div></section>`;
}
