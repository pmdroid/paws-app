import type { StatusEvidence, StatusSnapshot } from "../contract";
import {
  EVIDENCE_FILTERS,
  evidenceFileUrl,
  evidencePageHref,
  filterEvidence,
  kindLabel,
  measureLabel,
  runEvidence,
  sizeLabel,
  thumbnailMedia,
  type EvidenceFilter,
  type MediaInfo,
} from "./evidence";
import { ago, esc } from "./format";
import { buttonVariants } from "./ui/button";

type VideoJs = typeof import("video.js").default;
type Player = ReturnType<VideoJs>;

let videojs: Promise<VideoJs> | null = null;

/** video.js is bundled with the dashboard as its own chunk, loaded the first time a video plays. */
function loadVideoJs(): Promise<VideoJs> {
  videojs ??= import("video.js").then((module) => module.default);
  return videojs;
}

const BUTTON = buttonVariants({ variant: "neutral", size: "sm" });
const PRESSED = buttonVariants({ variant: "default", size: "sm" });
const ICON = buttonVariants({ variant: "neutral", size: "icon" });
const COPY_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';

export interface EvidenceMedia {
  readonly info: ReadonlyMap<string, MediaInfo>;
  /** Takes the gallery and the player out of `#page-content` right before it is re-rendered. */
  detach(): void;
  /** Puts them back into their placeholders, so thumbnails and playback are not reloaded. */
  attach(snapshot: StatusSnapshot | null, engineUrl: string | null): void;
  copyLink(id: string, button: HTMLButtonElement | null): void;
}

type Gallery = { key: string; root: HTMLElement; list: StatusEvidence[]; filter: EvidenceFilter };
type Shown = { id: string; root: HTMLElement; dispose(): void };

export function createEvidenceMedia(changed: () => void): EvidenceMedia {
  const info = new Map<string, MediaInfo>();
  let gallery: Gallery | null = null;
  let player: Shown | null = null;
  const lightbox = createLightbox(info, (id, button) => copyLink(id, button));

  document.addEventListener("loadedmetadata", (event) => learn(event.target), true);
  document.addEventListener("load", (event) => learn(event.target), true);

  function learn(target: EventTarget | null): void {
    if (!(target instanceof HTMLVideoElement || target instanceof HTMLImageElement)) return;
    const id = target.closest("[data-evidence-media]")?.getAttribute("data-evidence-media");
    if (!id || info.has(id)) return;
    if (target instanceof HTMLVideoElement && Number.isFinite(target.duration))
      info.set(id, { durationMs: target.duration * 1000 });
    else if (target instanceof HTMLImageElement && target.naturalWidth > 0)
      info.set(id, { width: target.naturalWidth, height: target.naturalHeight });
    else return;
    for (const label of document.querySelectorAll(`[data-evidence-measure="${CSS.escape(id)}"]`))
      label.textContent = badgeLabel(
        label.getAttribute("data-evidence-kind") === "video" ? "video" : "image",
        info.get(id),
      );
    changed();
  }

  function copyLink(id: string, button: HTMLButtonElement | null): void {
    const href = new URL(evidencePageHref(id), location.href).href;
    void navigator.clipboard?.writeText(href).then(
      () => flash(button, "Copied"),
      () => flash(button, "Copy failed"),
    );
  }

  return {
    info,
    copyLink,
    detach() {
      gallery?.root.remove();
      player?.root.remove();
    },
    attach(snapshot, engineUrl) {
      const slot = document.querySelector<HTMLElement>("#evidence-gallery[data-run]");
      const runId = slot?.dataset.run;
      if (slot && runId && snapshot) {
        const list = runEvidence(snapshot, runId);
        const key = `${engineUrl ?? ""}\n${runId}\n${list.map((entry) => entry.id).join(",")}`;
        if (gallery?.key !== key)
          gallery = buildGallery(key, list, engineUrl, slot.dataset.repo ?? "");
        if (gallery.root.parentElement !== slot) slot.append(gallery.root);
      } else if (!slot) {
        lightbox.close();
      }
      const stage = document.querySelector<HTMLElement>("#evidence-player[data-evidence]");
      const id = stage?.dataset.evidence;
      const evidence = id ? snapshot?.evidence?.find((entry) => entry.id === id) : undefined;
      if (player && player.id !== evidence?.id) {
        player.dispose();
        player = null;
      }
      if (!stage || !evidence) return;
      player ??= showMedia(evidence, engineUrl, "max-h-[70vh]");
      if (player.root.parentElement !== stage) stage.append(player.root);
    },
  };

  function buildGallery(
    key: string,
    list: StatusEvidence[],
    engineUrl: string | null,
    repo: string,
  ): Gallery {
    const root = document.createElement("section");
    root.className = "flex min-w-0 flex-col gap-4";
    root.setAttribute("aria-label", "Evidence");
    const built: Gallery = { key, root, list, filter: gallery?.filter ?? "all" };
    const filters = EVIDENCE_FILTERS.map(
      (entry) =>
        `<button type="button" class="${BUTTON}" data-evidence-filter="${entry.id}" aria-pressed="false">${entry.label} <span class="inline-flex size-5 items-center justify-center rounded-full border-2 border-current text-xs">${filterEvidence(list, entry.id).length}</span></button>`,
    ).join("");
    const tiles = list
      .map(
        (entry) =>
          `<li class="flex min-w-0 flex-col overflow-hidden rounded-base border-2 border-border bg-secondary-background shadow-shadow" data-evidence-tile="${esc(entry.id)}" data-evidence-kind="${entry.kind}">
            <button type="button" class="evidence-thumb relative block aspect-video w-full overflow-hidden border-b-2 border-border bg-background focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-ring" data-evidence-open="${esc(entry.id)}" aria-label="${esc(`Open ${kindLabel(entry.kind).toLowerCase()} ${entry.displayName}`)}">${thumbnailMedia(entry, engineUrl)}${entry.kind === "video" ? '<span class="absolute inset-0 m-auto flex size-10 items-center justify-center rounded-base border-2 border-border bg-main text-main-foreground" aria-hidden="true">▶</span>' : ""}<span class="absolute right-2 bottom-2 rounded-base border-2 border-border bg-secondary-background px-1.5 text-xs font-bold text-foreground" data-evidence-measure="${esc(entry.id)}" data-evidence-kind="${entry.kind}">${esc(badgeLabel(entry.kind, info.get(entry.id)))}</span></button>
            <div class="flex min-w-0 items-start justify-between gap-2 p-3">
              <div class="flex min-w-0 flex-col gap-1">
                <span class="font-heading leading-snug" title="${esc(entry.displayName)}">${esc(entry.displayName)}</span>
                <span class="truncate text-xs">${esc(entry.checkId)} · attempt ${entry.attempt}</span>
              </div>
              <button type="button" class="${buttonVariants({ variant: "neutral", size: "icon" })}" data-evidence-copy="${esc(entry.id)}" aria-label="${esc(`Copy link to ${entry.displayName}`)}" title="Copy link">${COPY_ICON}</button>
            </div>
          </li>`,
      )
      .join("");
    const visible = repo
      ? `Videos and screenshots the agent published with Closeout. Visible to signed-in members with access to ${esc(repo)}.`
      : "Videos and screenshots the agent published with Closeout.";
    root.innerHTML = `<div class="flex min-w-0 flex-wrap items-center justify-between gap-3"><h2 class="text-xl font-heading">Evidence</h2><div class="flex flex-wrap" role="group" aria-label="Filter evidence">${filters}</div></div><p class="-mt-2 text-sm">${visible}</p><ul class="m-0 grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">${tiles}</ul>`;
    root.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const filter = target
        ?.closest("[data-evidence-filter]")
        ?.getAttribute("data-evidence-filter");
      if (filter === "all" || filter === "video" || filter === "image") {
        built.filter = filter;
        applyFilter(built);
      }
      const open = target?.closest("[data-evidence-open]")?.getAttribute("data-evidence-open");
      if (open) {
        const shown = filterEvidence(built.list, built.filter);
        lightbox.open(
          shown,
          shown.findIndex((entry) => entry.id === open),
          engineUrl,
        );
      }
      const copy = target?.closest("button[data-evidence-copy]");
      if (copy instanceof HTMLButtonElement) copyLink(copy.dataset.evidenceCopy ?? "", copy);
    });
    applyFilter(built);
    return built;
  }
}

/** The thumbnail badge: a video's length or an image's size, once known. */
function badgeLabel(kind: StatusEvidence["kind"], media: MediaInfo | undefined): string {
  return measureLabel(kind, media) || kindLabel(kind);
}

function applyFilter(gallery: Gallery): void {
  for (const tile of gallery.root.querySelectorAll<HTMLElement>("[data-evidence-tile]"))
    tile.hidden = gallery.filter !== "all" && tile.dataset.evidenceKind !== gallery.filter;
  for (const button of gallery.root.querySelectorAll<HTMLButtonElement>("[data-evidence-filter]")) {
    const on = button.dataset.evidenceFilter === gallery.filter;
    button.setAttribute("aria-pressed", String(on));
    button.className = on ? PRESSED : BUTTON;
  }
}

function flash(button: HTMLButtonElement | null, label: string): void {
  if (!button) return;
  const before = button.textContent;
  button.textContent = label;
  window.setTimeout(() => {
    button.textContent = before;
  }, 1500);
}

/** An image, or a video played with video.js. Seeking uses the endpoint's byte ranges. */
function showMedia(evidence: StatusEvidence, engineUrl: string | null, height: string): Shown {
  const root = document.createElement("div");
  root.className = "min-w-0 overflow-hidden rounded-base border-2 border-border bg-black";
  root.dataset.evidenceMedia = evidence.id;
  const src = evidenceFileUrl(evidence.id, engineUrl);
  if (evidence.kind === "image") {
    const image = document.createElement("img");
    image.src = src;
    image.alt = evidence.displayName;
    image.className = `mx-auto block ${height} max-w-full object-contain`;
    root.append(image);
    return { id: evidence.id, root, dispose: () => root.remove() };
  }
  const video = document.createElement("video");
  video.className = "video-js vjs-big-play-centered";
  video.setAttribute("playsinline", "");
  video.setAttribute("aria-label", evidence.displayName);
  root.append(video);
  let instance: Player | null = null;
  let disposed = false;
  void loadVideoJs().then((create) => {
    if (disposed) return;
    instance = create(video, {
      controls: true,
      preload: "metadata",
      fluid: true,
      playbackRates: [0.5, 1, 1.5, 2],
      sources: [{ src, type: evidence.mediaType }],
    });
  });
  return {
    id: evidence.id,
    root,
    dispose() {
      disposed = true;
      instance?.dispose();
      root.remove();
    },
  };
}

type Lightbox = {
  open(list: StatusEvidence[], index: number, engineUrl: string | null): void;
  close(): void;
};

function createLightbox(
  info: ReadonlyMap<string, MediaInfo>,
  copyLink: (id: string, button: HTMLButtonElement | null) => void,
): Lightbox {
  const dialog = document.createElement("dialog");
  dialog.className =
    "m-auto w-full max-w-[calc(100%-2rem)] overflow-hidden rounded-base border-2 border-border bg-black p-0 text-foreground shadow-shadow backdrop:bg-overlay lg:max-w-5xl";
  dialog.setAttribute("aria-label", "Evidence");
  document.body.append(dialog);
  let list: StatusEvidence[] = [];
  let index = 0;
  let engine: string | null = null;
  let shown: Shown | null = null;

  function show(): void {
    shown?.dispose();
    const evidence = list[index];
    if (!evidence) return;
    const page = new URL(evidencePageHref(evidence.id), location.href).href;
    const facts = [
      `${evidence.checkId} · attempt ${evidence.attempt}`,
      [
        evidence.mediaType.replace(/^\w+\//, ""),
        sizeLabel(evidence.sizeBytes),
        measureLabel(evidence.kind, info.get(evidence.id)),
      ]
        .filter(Boolean)
        .join(" · "),
      `published by ${evidence.publisher} ${ago(evidence.publishedAt, new Date().toISOString())}`,
    ];
    dialog.innerHTML = `<div class="flex min-w-0 flex-col">
      <div class="flex min-w-0 items-center justify-between gap-3 border-b-2 border-border bg-secondary-background px-4 py-3">
        <h2 class="min-w-0 truncate font-heading">${esc(evidence.displayName)}</h2>
        <div class="flex shrink-0 items-center gap-2">
          <button type="button" class="${ICON}" data-lightbox-step="-1" aria-label="Previous"${index === 0 ? " disabled" : ""}>‹</button>
          <span class="text-xs" aria-live="polite">${index + 1} of ${list.length}</span>
          <button type="button" class="${ICON}" data-lightbox-step="1" aria-label="Next"${index === list.length - 1 ? " disabled" : ""}>›</button>
          <button type="button" class="${ICON}" data-lightbox-close aria-label="Close">×</button>
        </div>
      </div>
      <div data-lightbox-stage></div>
      <div class="flex min-w-0 flex-col gap-3 border-t-2 border-border bg-secondary-background px-4 py-3">
        <p class="text-xs">${facts.map(esc).join(" · ")}</p>
        <div class="flex min-w-0 flex-wrap items-stretch gap-2">
          <input class="min-h-control min-w-0 flex-1 basis-60 rounded-base border-2 border-border bg-secondary-background px-3 font-mono text-xs" readonly value="${esc(page)}" aria-label="Evidence link" />
          <button type="button" class="${PRESSED}" data-lightbox-copy="${esc(evidence.id)}">Copy link</button>
          <a class="${BUTTON}" href="${esc(evidencePageHref(evidence.id))}" data-lightbox-page>Open page</a>
          <a class="${BUTTON}" href="${esc(evidenceFileUrl(evidence.id, engine))}" download="${esc(evidence.displayName)}">Download</a>
        </div>
      </div>
    </div>`;
    shown = showMedia(evidence, engine, "max-h-[65vh]");
    shown.root.classList.remove("rounded-base", "border-2");
    dialog.querySelector("[data-lightbox-stage]")?.append(shown.root);
  }

  function step(delta: number): void {
    const next = index + delta;
    if (next < 0 || next >= list.length) return;
    index = next;
    show();
    dialog.querySelector<HTMLElement>(`[data-lightbox-step="${delta}"]:not([disabled])`)?.focus();
  }

  function close(): void {
    if (dialog.open) dialog.close();
  }

  dialog.addEventListener("close", () => {
    shown?.dispose();
    shown = null;
    dialog.replaceChildren();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) return close();
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-lightbox-close], [data-lightbox-page]")) return close();
    const copy = target?.closest<HTMLButtonElement>("button[data-lightbox-copy]");
    if (copy) return copyLink(copy.dataset.lightboxCopy ?? "", copy);
    const delta = Number(
      target?.closest("[data-lightbox-step]")?.getAttribute("data-lightbox-step"),
    );
    if (delta === 1 || delta === -1) step(delta);
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") step(-1);
    else if (event.key === "ArrowRight") step(1);
    else return;
    event.preventDefault();
  });

  return {
    open(next, at, engineUrl) {
      if (at < 0 || next.length === 0) return;
      list = next;
      index = at;
      engine = engineUrl;
      show();
      if (!dialog.open) dialog.showModal();
    },
    close,
  };
}
