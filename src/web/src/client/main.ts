import { parseStatusSnapshot, STATUS_API_VERSION, type StatusSnapshot } from "../contract";
import { demoStatus } from "../demo";
import { parseEngineUrl, statusEndpoint } from "../endpoint";
import { choiceFromValue, resolveEngineUrl, type SourceChoice } from "../source";
import {
  loadGitHubUser,
  readCsrfToken,
  renderGitHubSignIn,
  startGitHubDevice,
} from "./github-auth";
import { render, type RenderModel } from "./render";
import { parseRoute } from "./route";

import { createAgentSettings } from "./agent-settings";
import { canReadConversations, loadConversations, type ConversationModel } from "./conversations";

const settings = createAgentSettings(() => paint());

const STORAGE_KEY = "paws.statusEngineUrl";
const POLL_MS = 5000;

const regions = ["#side", "#top", "#banner", "#content", "#tabbar"] as const;
const painted = new Map<string, string>();

let choice: SourceChoice = { kind: "auto" };
let baked: string | null = null;
let epicView: "graph" | "board" = "graph";
let selectedCheck: { itemId: string; checkId: string } | null = null;
let phase: RenderModel["phase"] = "loading";
let snapshot: StatusSnapshot | null = null;
let via: RenderModel["via"] = null;
let error: string | null = null;
let timer = 0;
let conversations: ConversationModel = { state: "loading", sessions: [] };

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
void paintGitHubAuth(null);

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
    showFallback();
    schedule();
  }
}

async function reload(): Promise<void> {
  const engineUrl = currentEngine();
  if (!engineUrl) {
    showFallback();
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
    conversations = await loadConversations(engineUrl, snapshot.source, location.origin);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Could not load status";
    phase = "error";
    if (via !== "engine") snapshot = null;
  }
  paint();
  schedule();
}

function showFallback(): void {
  if (choice.kind === "demo" || !servedLocally()) showDemo();
  else showLocalEmpty();
}

function showDemo(): void {
  snapshot = demoStatus();
  via = "bundled";
  phase = "ready";
  error = null;
  paint();
}

function showLocalEmpty(): void {
  snapshot = {
    version: STATUS_API_VERSION,
    source: "live",
    generatedAt: new Date().toISOString(),
    project: { name: "Paws", team: "Paws", repo: "local", workspace: null },
    epics: [],
    items: [],
    runs: [],
    questions: [],
    verdicts: [],
    mergeQueue: [],
    events: [],
  };
  via = "engine";
  phase = "ready";
  error = null;
  paint();
}

function servedLocally(): boolean {
  return location.pathname === "/status" || location.pathname.startsWith("/status/");
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
    selectedCheck,
    conversations: canReadConversations(currentEngine(), snapshot?.source, location.origin)
      ? conversations
      : { state: "unavailable", sessions: [] },
  };
  const view = render(model);
  document.title = view.title;
  setHtml("#side", view.side);
  setHtml("#top", view.top);
  setHtml("#banner", view.banner);
  setHtml("#content", view.content);
  setHtml("#tabbar", view.tabbar);
  const settingsRoot = document.querySelector<HTMLElement>("#agent-settings");
  if (settingsRoot) settings.mount(settingsRoot, currentEngine());
}

function setHtml(selector: (typeof regions)[number], html: string): void {
  const element = document.querySelector(selector);
  if (!element || painted.get(selector) === html) return;
  const focus = selector === "#content" ? captureFocus(element) : null;
  const logs = selector === "#content" ? captureLogs(element) : [];
  const scroll = selector === "#content" ? element.scrollTop : 0;
  painted.set(selector, html);
  element.innerHTML = html;
  if (selector !== "#content") return;
  element.scrollTop = scroll;
  restoreLogs(element, logs);
  restoreFocus(element, focus);
}

type HeldFocus =
  | { kind: "action"; action: string; item: string; check: string }
  | { kind: "log"; key: string }
  | { kind: "href"; href: string };

type LogScroll = { key: string; top: number; stick: boolean };

function captureFocus(root: Element): HeldFocus | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active)) return null;
  if (active instanceof HTMLAnchorElement) {
    const href = active.getAttribute("href");
    if (href) return { kind: "href", href };
  }
  const log = active.closest("pre.out")?.getAttribute("data-log");
  if (log) return { kind: "log", key: log };
  const holder = active.closest("[data-action][data-item][data-check]");
  if (!(holder instanceof HTMLElement)) return null;
  const action = holder.getAttribute("data-action");
  const item = holder.getAttribute("data-item");
  const check = holder.getAttribute("data-check");
  if (!action || !item || !check) return null;
  return { kind: "action", action, item, check };
}

function restoreFocus(root: Element, held: HeldFocus | null): void {
  const target = held === null ? null : findHeld(root, held);
  if (!(target instanceof HTMLElement)) return;
  target.focus({ preventScroll: true });
}

function findHeld(root: Element, held: HeldFocus): Element | null {
  if (held.kind === "log") {
    for (const node of root.querySelectorAll("pre.out")) {
      if (node.getAttribute("data-log") === held.key) return node;
    }
    return null;
  }
  if (held.kind === "href") {
    for (const link of root.querySelectorAll("a[href]")) {
      if (link.getAttribute("href") === held.href) return link;
    }
    return null;
  }
  for (const node of root.querySelectorAll("[data-action][data-item][data-check]")) {
    if (
      node.getAttribute("data-action") === held.action &&
      node.getAttribute("data-item") === held.item &&
      node.getAttribute("data-check") === held.check
    ) {
      return node;
    }
  }
  return null;
}

function captureLogs(root: Element): LogScroll[] {
  const logs: LogScroll[] = [];
  for (const node of root.querySelectorAll("pre.out")) {
    if (!(node instanceof HTMLElement)) continue;
    const key = node.getAttribute("data-log");
    if (!key) continue;
    const stick = node.scrollHeight - node.scrollTop - node.clientHeight <= 8;
    logs.push({ key, top: node.scrollTop, stick });
  }
  return logs;
}

function restoreLogs(root: Element, logs: readonly LogScroll[]): void {
  for (const saved of logs) {
    for (const node of root.querySelectorAll("pre.out")) {
      if (!(node instanceof HTMLElement) || node.getAttribute("data-log") !== saved.key) continue;
      node.scrollTop = saved.stick ? node.scrollHeight : saved.top;
    }
  }
}

function onClick(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const action = target.closest("[data-action]")?.getAttribute("data-action");
  if (!action) return;
  if (action === "drawer") document.body.classList.add("drawer-open");
  if (action === "drawer-close") document.body.classList.remove("drawer-open");
  if (action === "github-signin") void signInWithGitHub();
  if (action === "refresh") void reload();
  if (action === "source") openDialog();
  if (action === "epic-view") {
    const mode = target.closest("[data-mode]")?.getAttribute("data-mode");
    if (mode === "graph" || mode === "board") {
      epicView = mode;
      paint();
    }
  }
  if (action === "select-check") {
    const row = target.closest("[data-item][data-check]");
    const itemId = row?.getAttribute("data-item");
    const checkId = row?.getAttribute("data-check");
    if (itemId && checkId) {
      selectedCheck = { itemId, checkId };
      paint();
    }
  }
  if (action === "download-output") {
    const row = target.closest("[data-item][data-check]");
    const itemId = row?.getAttribute("data-item");
    const checkId = row?.getAttribute("data-check");
    if (itemId && checkId) downloadOutput(itemId, checkId);
  }
}

async function paintGitHubAuth(
  device: { userCode: string; verificationUri: string } | null,
): Promise<void> {
  const slot = document.querySelector("#github-auth");
  if (!slot) return;
  const user = await loadGitHubUser().catch(() => null);
  slot.innerHTML = renderGitHubSignIn({ user, device: user ? null : device });
}

async function signInWithGitHub(): Promise<void> {
  const slot = document.querySelector("#github-auth");
  try {
    const device = await startGitHubDevice(readCsrfToken(document));
    if (slot) slot.innerHTML = renderGitHubSignIn({ user: null, device });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => {
        window.setTimeout(resolve, 1500);
      });
      const user = await loadGitHubUser().catch(() => null);
      if (user) {
        if (slot) slot.innerHTML = renderGitHubSignIn({ user, device: null });
        return;
      }
    }
  } catch {
    if (slot) slot.innerHTML = renderGitHubSignIn({ user: null, device: null });
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
  if (!currentEngine()) showFallback();
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
  if (servedLocally()) return "Automatic. This page reads the local engine.";
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

function downloadOutput(itemId: string, checkId: string): void {
  const check = snapshot?.verdicts
    .find((verdict) => verdict.itemId === itemId)
    ?.checks.find((entry) => entry.id === checkId);
  if (!check) return;
  const body = `STDOUT\n${check.stdout ?? ""}\nSTDERR\n${check.stderr ?? ""}\n`;
  const blob = new Blob([body], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${checkId}.log`;
  link.click();
  URL.revokeObjectURL(url);
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
