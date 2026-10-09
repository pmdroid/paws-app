import { parseStatusSnapshot, type StatusSnapshot } from "../contract";
import { demoStatus } from "../demo";
import { parseEngineUrl, statusEndpoint } from "../endpoint";
import { choiceFromValue, resolveEngineUrl, type SourceChoice } from "../source";
import { render, type RenderModel } from "./render";
import { parseRoute } from "./route";

const STORAGE_KEY = "paws.statusEngineUrl";
const POLL_MS = 5000;

const regions = ["#side", "#top", "#banner", "#content", "#tabbar"] as const;
const painted = new Map<string, string>();

let choice: SourceChoice = { kind: "auto" };
let baked: string | null = null;
let epicView: "graph" | "board" = "graph";
let phase: RenderModel["phase"] = "loading";
let snapshot: StatusSnapshot | null = null;
let via: RenderModel["via"] = null;
let error: string | null = null;
let timer = 0;

const dialog = document.querySelector("#source-dialog");
const form = document.querySelector("#source-form");
const help = document.querySelector("#source-help");
const fieldError = document.querySelector("#source-error");
const demoButton = document.querySelector("#source-demo");

document.addEventListener("click", onClick);
window.addEventListener("hashchange", () => {
  document.body.classList.remove("drawer-open");
  paint();
});
form?.addEventListener("submit", onSave);
demoButton?.addEventListener("click", () => {
  applyChoice({ kind: "demo" });
  closeDialog();
});

void boot();

async function boot(): Promise<void> {
  const query = new URLSearchParams(location.search).get("engine");
  const fromQuery = query === null ? null : choiceFromValue(query);
  if (fromQuery) {
    choice = fromQuery;
    persist(choice);
  } else {
    choice = choiceFromValue(storageGet(STORAGE_KEY)) ?? { kind: "auto" };
  }
  baked = await loadBakedEngineUrl();
  epicView = window.matchMedia("(max-width: 900px)").matches ? "board" : "graph";
  if (currentEngine()) {
    phase = "loading";
    paint();
    await reload();
  } else {
    showDemo();
    schedule();
  }
}

async function reload(): Promise<void> {
  const engineUrl = currentEngine();
  if (!engineUrl) {
    showDemo();
    schedule();
    return;
  }
  try {
    const response = await fetch(statusEndpoint(engineUrl), {
      headers: { Accept: "application/json", "ngrok-skip-browser-warning": "1" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(await errorText(response));
    const parsed = parseStatusSnapshot(await response.json());
    if (!parsed.ok) throw new Error(parsed.error);
    snapshot = parsed.snapshot;
    via = "engine";
    phase = "ready";
    error = null;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load status";
    phase = "error";
    if (via !== "engine") snapshot = null;
  }
  paint();
  schedule();
}

function showDemo(): void {
  snapshot = demoStatus();
  via = "bundled";
  phase = "ready";
  error = null;
  paint();
}

function schedule(): void {
  window.clearInterval(timer);
  if (!currentEngine()) return;
  timer = window.setInterval(() => {
    void reload();
  }, POLL_MS);
}

function paint(): void {
  const model: RenderModel = {
    route: parseRoute(location.hash),
    phase,
    snapshot,
    via,
    error,
    engineUrl: currentEngine(),
    epicView,
  };
  const view = render(model);
  document.title = view.title;
  setHtml("#side", view.side);
  setHtml("#top", view.top);
  setHtml("#banner", view.banner);
  setHtml("#content", view.content);
  setHtml("#tabbar", view.tabbar);
}

function setHtml(selector: (typeof regions)[number], html: string): void {
  const element = document.querySelector(selector);
  if (!element || painted.get(selector) === html) return;
  const scroll = selector === "#content" ? element.scrollTop : 0;
  painted.set(selector, html);
  element.innerHTML = html;
  if (selector === "#content") element.scrollTop = scroll;
}

function onClick(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const action = target.closest("[data-action]")?.getAttribute("data-action");
  if (!action) return;
  if (action === "drawer") document.body.classList.add("drawer-open");
  if (action === "drawer-close") document.body.classList.remove("drawer-open");
  if (action === "refresh") void reload();
  if (action === "source") openDialog();
  if (action === "epic-view") {
    const mode = target.closest("[data-mode]")?.getAttribute("data-mode");
    if (mode === "graph" || mode === "board") {
      epicView = mode;
      paint();
    }
  }
}

function openDialog(): void {
  if (!(dialog instanceof HTMLDialogElement) || !(form instanceof HTMLFormElement)) return;
  const input = form.querySelector("input");
  if (input) input.value = choice.kind === "engine" ? choice.url : "";
  if (help) help.textContent = sourceHelp();
  if (fieldError) fieldError.textContent = "";
  dialog.showModal();
}

function onSave(event: Event): void {
  event.preventDefault();
  if (!(form instanceof HTMLFormElement)) return;
  const raw = String(new FormData(form).get("engine") ?? "").trim();
  if (!raw) {
    applyChoice({ kind: "auto" });
    closeDialog();
    return;
  }
  const url = parseEngineUrl(raw);
  if (!url) {
    if (fieldError)
      fieldError.textContent = "Enter an http or https URL, or leave the field empty.";
    return;
  }
  applyChoice({ kind: "engine", url });
  closeDialog();
}

function applyChoice(next: SourceChoice): void {
  choice = next;
  persist(next);
  const url = new URL(location.href);
  if (url.searchParams.has("engine")) {
    url.searchParams.delete("engine");
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }
  if (!currentEngine()) showDemo();
  else {
    phase = "loading";
    snapshot = null;
    via = null;
    paint();
  }
  void reload();
}

function closeDialog(): void {
  if (dialog instanceof HTMLDialogElement) dialog.close();
}

function sourceHelp(): string {
  const engine = currentEngine();
  if (choice.kind === "demo") return "Showing bundled demo data.";
  if (choice.kind === "engine") return `Showing ${choice.url}.`;
  if (engine) return `Automatic. This page will use ${engine}.`;
  return "Automatic. This static site shows demo data until an engine URL is saved.";
}

function currentEngine(): string | null {
  return resolveEngineUrl({
    choice,
    baked,
    pathname: location.pathname,
    origin: location.origin,
  });
}

function persist(next: SourceChoice): void {
  if (next.kind === "auto") storageSet(STORAGE_KEY, null);
  else if (next.kind === "demo") storageSet(STORAGE_KEY, "demo");
  else storageSet(STORAGE_KEY, next.url);
}

async function loadBakedEngineUrl(): Promise<string | null> {
  try {
    const response = await fetch(new URL("config.json", document.baseURI), { cache: "no-store" });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("engineUrl" in body)) return null;
    const value = body.engineUrl;
    if (typeof value !== "string") return null;
    return parseEngineUrl(value);
  } catch {
    return null;
  }
}

async function errorText(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
      return `Engine responded ${response.status}: ${body.error}`;
    }
  } catch {
    /* status is enough */
  }
  return `Engine responded ${response.status}`;
}

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}
