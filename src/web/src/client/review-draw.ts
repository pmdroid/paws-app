import { journalCaught } from "../../../journal";
import type { StatusSnapshot } from "../contract";
import { evidenceFileUrl } from "./evidence";
import { esc } from "./format";
import { readCsrfToken } from "./csrf";
import { renderMarkup } from "./theme";

export type ReviewShot = { id: string; name: string; src: string };
export type Stroke = (readonly [number, number])[];

const INK = "#e5484d";
const WIDTH = 0.006;

export function drawStrokes(
  context: CanvasRenderingContext2D,
  strokes: readonly Stroke[],
  width: number,
  height: number,
): void {
  context.strokeStyle = INK;
  context.lineWidth = Math.max(2, WIDTH * width);
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const stroke of strokes) {
    const [first, ...rest] = stroke;
    if (!first) continue;
    context.beginPath();
    context.moveTo(first[0] * width, first[1] * height);
    for (const [x, y] of rest.length ? rest : [first]) context.lineTo(x * width, y * height);
    context.stroke();
  }
}

export function reviewShots(
  snapshot: StatusSnapshot,
  questionId: string,
  engineUrl: string | null,
): ReviewShot[] {
  const review = snapshot.items
    .flatMap((item) => item.visualReviews ?? [])
    .find((entry) => entry.questionId === questionId);
  // Screens that carried an approval over were not asked about.
  const carried = new Set((review?.carried ?? []).map((entry) => entry.evidenceId));
  return (review?.evidenceIds ?? []).flatMap((id) => {
    if (carried.has(id)) return [];
    const entry = snapshot.evidence?.find((row) => row.id === id && row.kind === "image");
    return entry ? [{ id, name: entry.displayName, src: evidenceFileUrl(id, engineUrl) }] : [];
  });
}

export function reviewDrawMarkup(shots: readonly ReviewShot[]): string {
  const list = shots
    .map(
      (shot, index) =>
        `<li><button type="button" class="review-draw-shot" data-draw-shot="${index}" aria-pressed="${index === 0}"><img src="${esc(shot.src)}" alt="" /><span data-draw-count>${esc(shot.name)}</span></button></li>`,
    )
    .join("");
  return `<dialog class="review-draw" aria-labelledby="review-draw-heading"><div class="dialog-body review-draw-body"><div class="between"><h2 id="review-draw-heading">Request changes</h2><button class="btn" type="button" data-draw-close>Close</button></div><p class="sub">Draw on the screenshots to mark what needs work. The agent gets each marked screenshot with your note.</p>${shots.length > 1 ? `<ul class="review-draw-shots">${list}</ul>` : ""}<div class="review-draw-stage"><img data-draw-image src="${esc(shots[0]?.src ?? "")}" alt="${esc(shots[0]?.name ?? "")}" /><canvas data-draw-canvas aria-label="Draw on the screenshot"></canvas></div><div class="row"><button class="btn sm" type="button" data-draw-undo>Undo</button><button class="btn sm" type="button" data-draw-clear>Clear</button></div><label class="field"><span>Note for the agent</span><textarea data-draw-note rows="3" maxlength="10000" placeholder="Move this button left"></textarea></label><p class="muted" data-draw-message role="status"></p><div class="row"><button class="btn primary" type="button" data-draw-submit>Request changes</button></div></div></dialog>`;
}

export function openReviewDraw(
  questionId: string,
  shots: readonly ReviewShot[],
  done: () => Promise<void>,
): void {
  const host = document.createElement("div");
  document.body.append(host);
  renderMarkup(host, reviewDrawMarkup(shots));
  const dialog = host.querySelector<HTMLDialogElement>("dialog")!;
  const image = dialog.querySelector<HTMLImageElement>("[data-draw-image]")!;
  const canvas = dialog.querySelector<HTMLCanvasElement>("[data-draw-canvas]")!;
  const note = dialog.querySelector<HTMLTextAreaElement>("[data-draw-note]")!;
  const message = dialog.querySelector<HTMLElement>("[data-draw-message]")!;
  const submit = dialog.querySelector<HTMLButtonElement>("[data-draw-submit]")!;
  const strokes = new Map<string, Stroke[]>(shots.map((shot) => [shot.id, []]));
  let selected = 0;
  let active: Stroke | null = null;
  const current = () => strokes.get(shots[selected]!.id)!;

  function redraw() {
    const scale = window.devicePixelRatio || 1;
    const width = image.clientWidth;
    const height = image.clientHeight;
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, width, height);
    drawStrokes(context, current(), width, height);
  }

  function counts() {
    dialog.querySelectorAll<HTMLButtonElement>("[data-draw-shot]").forEach((button, index) => {
      const marks = strokes.get(shots[index]!.id)!.length;
      button.setAttribute("aria-pressed", String(index === selected));
      button.querySelector("[data-draw-count]")!.textContent = marks
        ? `${shots[index]!.name} · ${marks} ${marks === 1 ? "mark" : "marks"}`
        : shots[index]!.name;
    });
  }

  function point(event: PointerEvent): [number, number] {
    const box = canvas.getBoundingClientRect();
    return [
      Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
      Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
    ];
  }

  canvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    active = [point(event)];
    current().push(active);
    redraw();
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!active) return;
    active.push(point(event));
    redraw();
  });
  for (const type of ["pointerup", "pointercancel"] as const)
    canvas.addEventListener(type, () => {
      if (!active) return;
      active = null;
      counts();
    });
  image.addEventListener("load", redraw);
  new ResizeObserver(redraw).observe(image);
  dialog.querySelectorAll<HTMLButtonElement>("[data-draw-shot]").forEach((button, index) =>
    button.addEventListener("click", () => {
      selected = index;
      image.src = shots[index]!.src;
      image.alt = shots[index]!.name;
      counts();
      redraw();
    }),
  );
  dialog.querySelector("[data-draw-undo]")!.addEventListener("click", () => {
    current().pop();
    counts();
    redraw();
  });
  dialog.querySelector("[data-draw-clear]")!.addEventListener("click", () => {
    current().splice(0);
    counts();
    redraw();
  });
  dialog.querySelector("[data-draw-close]")!.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => host.remove());
  submit.addEventListener("click", async () => {
    const marked = shots.filter((shot) => strokes.get(shot.id)!.length);
    if (!marked.length && !note.value.trim()) {
      message.textContent = "Draw on a screenshot or write what to change.";
      return;
    }
    submit.disabled = true;
    message.textContent = "Sending…";
    try {
      const form = new FormData();
      form.append("questionId", questionId);
      form.append("note", note.value);
      for (const shot of marked)
        form.append(`mark:${shot.id}`, await composite(shot, strokes.get(shot.id)!), "mark.png");
      const response = await fetch("/api/visual-review-changes", {
        method: "POST",
        headers: { "x-paws-csrf": readCsrfToken(document) },
        body: form,
      });
      const body = (await response.json().catch((caughtError1) => {
        journalCaught(caughtError1, "review-draw.openReviewDraw.json", null);
        return null;
      })) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? "The changes could not be sent. Try again.");
      dialog.close();
      await done();
    } catch (error) {
      journalCaught(error, "review-draw.openReviewDraw.append", null);
      message.textContent =
        error instanceof Error ? error.message : "The changes could not be sent. Try again.";
      submit.disabled = false;
    }
  });
  dialog.showModal();
  counts();
}

async function composite(shot: ReviewShot, strokes: readonly Stroke[]): Promise<Blob> {
  const image = new Image();
  image.src = shot.src;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d")!;
  context.drawImage(image, 0, 0);
  drawStrokes(context, strokes, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("The marked screenshot failed."))),
      "image/png",
    ),
  );
}

export function createReviewDraw(reload: () => Promise<void>) {
  return {
    mount(
      element: HTMLElement,
      snapshot: StatusSnapshot | null,
      engineUrl: string | null,
      source: string | undefined,
    ) {
      const local =
        engineUrl !== null && new URL(engineUrl).origin === location.origin && source === "live";
      const questionId = element.dataset["question"] ?? "";
      const shots = snapshot && local ? reviewShots(snapshot, questionId, engineUrl) : [];
      element.hidden = shots.length === 0;
      if (element.hidden || element.querySelector("button")) return;
      renderMarkup(
        element,
        `<div class="row"><button class="btn primary" type="button">Draw on screenshots</button></div>`,
      );
      element
        .querySelector("button")!
        .addEventListener("click", () => openReviewDraw(questionId, shots, reload));
    },
  };
}
