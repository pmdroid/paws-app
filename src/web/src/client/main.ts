import { renderMarkup } from "./theme";
import { mountShell } from "./shell";
import { createSourceDialog } from "./source-dialog";

import { parseStatusSnapshot, STATUS_API_VERSION, type StatusSnapshot } from "../contract";
import { demoStatus } from "../demo";
import { parseEngineUrl, statusEndpoint } from "../endpoint";
import { choiceFromValue, resolveEngineUrl, type SourceChoice } from "../source";
import {
  loadGitHubAccess,
  readCsrfToken,
  renderGitHubSignIn,
  startGitHubDevice,
} from "./github-auth";
import {
  attemptsOf,
  checkAnchor,
  checkHash,
  checkKey,
  emptyCloseoutView,
  isOpen,
  parseCheckHash,
} from "./closeout";
import { agentCloseoutRun, agentVerdict, findAgentCloseout } from "./agent-closeout";
import { render, type RenderModel } from "./render";
import { matchRoute, needsSnapshot, parseRoute, routerBase, type Route } from "./route";
import type { SettingsPage } from "./settings-pages";

import { createAgentSettings } from "./agent-settings";
import { canReadConversations, loadConversations, type ConversationModel } from "./conversations";
import { createSessionStart } from "./session-start";
import { createRunners } from "./runners";
import { createProjects } from "./projects";
import { createExecutionControls } from "./execution-controls";
import { createEvidenceMedia } from "./evidence-media";
import {
  initializeWorkspaceAccess,
  showWorkspaceSettingsPage,
  takeSignInReturn,
} from "./workspace";

redirectLegacyHash();
const shell = mountShell();
const router = shell.router;

const settings = createAgentSettings(() => paint());
const sessionStart = createSessionStart(reload);
const runners = createRunners();
const projects = createProjects();
const executionControls = createExecutionControls(reload);
const evidence = createEvidenceMedia(() => paint());

const STORAGE_KEY = "paws.statusEngineUrl";
const POLL_MS = 5000;

const regions = ["#top", "#banner", "#page-content"] as const;
const painted = new Map<string, string>();

let choice: SourceChoice = { kind: "auto" };
let baked: string | null = null;
const closeout = emptyCloseoutView();
let linkedHash = "";
let phase: RenderModel["phase"] = "loading";
let snapshot: StatusSnapshot | null = null;
let via: RenderModel["via"] = null;
let error: string | null = null;
let timer = 0;
let workspaceReady = false;
let booted = false;
let shownPath = router.state.location.pathname;
let conversations: ConversationModel = { state: "loading", sessions: [] };

const sourceDialog = createSourceDialog(applyChoice);
let issueFilter: "all" | "active" | "needs" | "done" = "all";

document.addEventListener("click", onClick);
router.subscribe((state) => {
  if (state.location.pathname === shownPath) return;
  shownPath = state.location.pathname;
  routeChanged();
  window.scrollTo({ top: 0, behavior: "instant" });
  document.querySelector<HTMLElement>("#content")?.focus({ preventScroll: true });
});
document.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement) || target.dataset.routePicker === undefined) return;
  const path = appPath(target.value);
  if (path !== null && ["issues", "runs", "sessions"].includes(parseRoute(path).view))
    void router.navigate(path);
});

void boot();

async function boot(): Promise<void> {
  workspaceReady = await initializeWorkspaceAccess(() => settingsPage(currentRoute()));
  shell.setAuthenticated(workspaceReady);
  if (!workspaceReady) return;
  try {
    const destination = sessionStorage.getItem("paws.settingsReturn");
    sessionStorage.removeItem("paws.settingsReturn");
    if (["/settings/integrations", "/settings/account"].includes(destination ?? ""))
      await router.navigate(destination!, { replace: true });
    else {
      const back = signInReturn();
      if (back !== null) await router.navigate(back, { replace: true });
    }
  } catch {}
  const query = new URLSearchParams(location.search).get("engine");
  const fromQuery = query === null ? null : choiceFromValue(query);
  if (fromQuery) {
    choice = fromQuery;
    persist(choice);
  } else {
    choice = choiceFromValue(storageGet(STORAGE_KEY)) ?? { kind: "auto" };
  }
  baked = await loadBakedEngineUrl();
  booted = true;
  if (settingsPage(currentRoute()) === "account") void paintGitHubAuth(null);
  if (currentEngine()) {
    phase = "loading";
    paint();
    await reload();
  } else {
    showFallback();
    schedule();
  }
}

function routeChanged(): void {
  paint();
  if (!booted) return;
  if (settingsPage(currentRoute()) === "account") void paintGitHubAuth(null);
  void reload();
}

async function reload(): Promise<void> {
  const engineUrl = currentEngine();
  if (!engineUrl) {
    showFallback();
    schedule();
    return;
  }
  const route = currentRoute();
  if (route.view === "sessions") {
    conversations = await loadConversations(engineUrl, source(), location.origin);
    paint();
    schedule();
    return;
  }
  if (!needsSnapshot(route)) {
    schedule();
    return;
  }
  try {
    const response = await fetch(statusEndpoint(engineUrl), {
      headers: { Accept: "application/json", "ngrok-skip-browser-warning": "1" },
      cache: "no-store",
    });
    if (response.status === 401) {
      workspaceReady = await initializeWorkspaceAccess(() => settingsPage(currentRoute()));
      shell.setAuthenticated(workspaceReady);
      if (!workspaceReady) return;
    }
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
  const route = currentRoute();
  if (!currentEngine() || !(needsSnapshot(route) || route.view === "sessions")) return;
  // Stored evidence does not change, and a repaint would interrupt the video.
  if (route.view === "evidence") return;
  timer = window.setInterval(() => {
    void reload();
  }, POLL_MS);
}

function paint(): void {
  if (!workspaceReady) return;
  const model: RenderModel = {
    route: currentRoute(),
    phase,
    snapshot,
    via,
    error,
    engineUrl: currentEngine(),
    closeout,
    mediaInfo: evidence.info,
    conversations: canReadConversations(currentEngine(), source(), location.origin)
      ? conversations
      : { state: "unavailable", sessions: [] },
  };
  const view = render(model);
  const route = model.route;
  const detail =
    route.view === "runs"
      ? snapshot?.runs.find((entry) => entry.id === route.id)
      : route.view === "evidence"
        ? snapshot?.evidence?.find((entry) => entry.id === route.id)
        : null;
  shell.setBreadcrumb(
    detail
      ? { issueId: detail.itemId, entityId: detail.id }
      : model.route.view === "evidence" && model.route.id
        ? { issueId: null, entityId: model.route.id }
        : null,
  );
  const showSettings = model.route.view === "settings";
  const access = document.querySelector<HTMLElement>("#workspace-access");
  const auth = document.querySelector<HTMLElement>("#github-auth");
  if (access && access.dataset.loaded === "true")
    access.hidden =
      !showSettings ||
      model.route.view !== "settings" ||
      (model.route.page ?? "agents") === "agents";
  if (auth)
    auth.hidden =
      !showSettings ||
      model.route.view !== "settings" ||
      model.route.page !== "account" ||
      access?.dataset.workspace === "true";
  showWorkspaceSettingsPage(
    model.route.view === "settings" ? (model.route.page ?? "agents") : null,
  );
  document.title = view.title;
  setHtml("#top", view.top);
  setHtml("#banner", view.banner);
  setHtml("#page-content", view.content);
  evidence.attach(snapshot, currentEngine());
  applyIssueFilter();
  if (openLinkedCheck()) return;

  const settingsRoot = document.querySelector<HTMLElement>("#agent-settings");
  if (settingsRoot) settings.mount(settingsRoot, currentEngine());
  const sessionRoot = document.querySelector<HTMLElement>("#linear-session-start");
  if (sessionRoot)
    sessionStart.mount(sessionRoot, currentEngine(), source(), model.route.view === "sessions");
  const executionRoot = document.querySelector<HTMLElement>("#execution-controls");
  if (executionRoot) executionControls.mount(executionRoot, currentEngine(), source());
  const runnerRoot = document.querySelector<HTMLElement>("#runner-settings");
  if (runnerRoot && model.route.view === "runners")
    runners.mount(runnerRoot, currentEngine(), source(), model.route.id);
  const projectRoot = document.querySelector<HTMLElement>("#project-delivery");
  if (projectRoot) projects.mount(projectRoot, currentEngine(), source());
}

function currentRoute(): Route {
  const pathname = router.state.location.pathname;
  return parseRoute(pathname.slice(routerBase(pathname).length), snapshot);
}

function settingsPage(route: Route): SettingsPage | null {
  return route.view === "settings" ? (route.page ?? "agents") : null;
}

function source(): string {
  return snapshot?.source ?? (currentEngine() ? "live" : "demo");
}

function appPath(href: string): string | null {
  const url = new URL(href, location.href);
  const base = routerBase(location.pathname);
  if (url.origin !== location.origin) return null;
  if (base && url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return null;
  const path = url.pathname.slice(base.length) || "/";
  return matchRoute(path) ? `${path}${url.search}` : null;
}

/** The link a signed-out reader opened, so sign-in returns there instead of the overview. */
function signInReturn(): string | null {
  const stored = takeSignInReturn();
  if (stored === null) return null;
  const path = appPath(stored);
  return path === null ? null : `${path}${new URL(stored, location.href).hash}`;
}

function redirectLegacyHash(): void {
  if (!location.hash.startsWith("#/")) return;
  const path = `${routerBase(location.pathname)}${location.hash.slice(1)}`;
  history.replaceState(null, "", `${path}${location.search}`);
}

function followLink(event: MouseEvent, target: Element): void {
  const link = target.closest("a[href]");
  if (
    !(link instanceof HTMLAnchorElement) ||
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    link.target ||
    link.hasAttribute("download") ||
    link.getAttribute("href")?.startsWith("#")
  )
    return;
  const path = appPath(link.href);
  if (path === null) return;
  event.preventDefault();
  void router.navigate(path);
}

function setHtml(selector: (typeof regions)[number], html: string): void {
  const element = document.querySelector(selector);
  if (!element || painted.get(selector) === html) return;
  const focus = selector === "#page-content" ? captureFocus(element) : null;
  const logs = selector === "#page-content" ? captureLogs(element) : [];
  const scroll = selector === "#page-content" ? window.scrollY : 0;
  painted.set(selector, html);
  if (selector === "#page-content") evidence.detach();
  renderMarkup(element, html);
  if (selector !== "#page-content") return;
  window.scrollTo({ top: scroll, behavior: "instant" });
  restoreLogs(element, logs);
  restoreFocus(element, focus);
}

type HeldFocus =
  | {
      kind: "action";
      action: string;
      item: string;
      check: string;
      stream: string | null;
      attempt: string | null;
    }
  | { kind: "log"; key: string }
  | { kind: "href"; href: string }
  | { kind: "tab"; text: string }
  | { kind: "picker"; label: string };

type LogScroll = { key: string; top: number; stick: boolean };

function captureFocus(root: Element): HeldFocus | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active)) return null;
  if (active instanceof HTMLAnchorElement) {
    const href = active.getAttribute("href");
    if (href) return { kind: "href", href };
  }
  if (active.getAttribute("role") === "tab") return { kind: "tab", text: active.textContent ?? "" };
  if (active.matches("select[data-route-picker]"))
    return { kind: "picker", label: active.getAttribute("aria-label") ?? "" };
  const log = active.closest("[data-log]")?.getAttribute("data-log");
  if (log) return { kind: "log", key: log };
  const holder = active.closest("[data-action][data-item][data-check]");
  if (!(holder instanceof HTMLElement)) return null;
  const action = holder.getAttribute("data-action");
  const item = holder.getAttribute("data-item");
  const check = holder.getAttribute("data-check");
  if (!action || !item || !check) return null;
  return {
    kind: "action",
    action,
    item,
    check,
    stream: holder.getAttribute("data-stream"),
    attempt: holder.getAttribute("data-attempt"),
  };
}

function restoreFocus(root: Element, held: HeldFocus | null): void {
  const target = held === null ? null : findHeld(root, held);
  if (!(target instanceof HTMLElement)) return;
  target.focus({ preventScroll: true });
}

function findHeld(root: Element, held: HeldFocus): Element | null {
  if (held.kind === "tab")
    return (
      [...root.querySelectorAll('[role="tab"]')].find((node) => node.textContent === held.text) ??
      null
    );
  if (held.kind === "picker")
    return (
      [...root.querySelectorAll("select[data-route-picker]")].find(
        (node) => node.getAttribute("aria-label") === held.label,
      ) ?? null
    );
  if (held.kind === "log") {
    for (const node of root.querySelectorAll("[data-log]")) {
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
      node.getAttribute("data-check") === held.check &&
      node.getAttribute("data-stream") === held.stream &&
      node.getAttribute("data-attempt") === held.attempt
    ) {
      return node;
    }
  }
  return null;
}

function captureLogs(root: Element): LogScroll[] {
  const logs: LogScroll[] = [];
  for (const node of root.querySelectorAll("[data-log]")) {
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
    for (const node of root.querySelectorAll("[data-log]")) {
      if (!(node instanceof HTMLElement) || node.getAttribute("data-log") !== saved.key) continue;
      node.scrollTop = saved.stick ? node.scrollHeight : saved.top;
    }
  }
}

function onClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  followLink(event, target);
  const action = target.closest("[data-action]")?.getAttribute("data-action");
  if (!action) return;
  if (action === "github-signin") void signInWithGitHub();
  if (action === "refresh") {
    void reload();
    if (settingsPage(currentRoute()) === "account") void paintGitHubAuth(null);
    if (currentRoute().view === "runners") void runners.refresh();
    if (currentRoute().view === "projects") void projects.refresh();
  }
  if (action === "source") openDialog();
  if (action === "issue-filter") {
    const filter = target.closest("[data-issue-filter]")?.getAttribute("data-issue-filter");
    if (filter === "all" || filter === "active" || filter === "needs" || filter === "done") {
      issueFilter = filter;
      applyIssueFilter();
    }
  }
  if (action === "evidence-copy") {
    const button = target.closest<HTMLButtonElement>("button[data-evidence]");
    if (button) evidence.copyLink(button.dataset.evidence ?? "", button);
  }
  const holder = target.closest("[data-item]");
  const itemId = holder?.getAttribute("data-item") ?? "";
  const attempt = Number(holder?.getAttribute("data-attempt") ?? "");
  const checkId = holder?.getAttribute("data-check") ?? "";
  if (!itemId || !Number.isInteger(attempt) || attempt < 1) return;
  if (action === "agent-closeout-toggle") {
    closeout.open[`section\n${itemId}`] = holder?.getAttribute("data-open") !== "true";
    paint();
  }
  if (action === "closeout-attempt") {
    closeout.attempt[itemId] = attempt;
    paint();
  }
  if (action === "closeout-expand-all") {
    const checks = closeoutChecks(itemId, attempt);
    const open = !checks.every((check) => isOpen(closeout, itemId, attempt, check));
    for (const check of checks) closeout.open[checkKey(itemId, attempt, check.id)] = open;
    paint();
  }
  if (!checkId) return;
  const key = checkKey(itemId, attempt, checkId);
  if (action === "toggle-check") {
    const check = closeoutChecks(itemId, attempt).find((entry) => entry.id === checkId);
    if (check) closeout.open[key] = !isOpen(closeout, itemId, attempt, check);
    paint();
  }
  if (action === "check-stream") {
    const stream = holder?.getAttribute("data-stream");
    if (stream === "stdout" || stream === "stderr") {
      closeout.stream ??= {};
      closeout.stream[key] = stream;
      paint();
    }
  }
  if (action === "wrap-output") {
    closeout.wrap[key] = !closeout.wrap[key];
    paint();
  }
  if (action === "copy-check-link") {
    const url = new URL(location.href);
    url.hash = checkHash(attempt, checkId);
    void navigator.clipboard?.writeText(url.href).then(
      () => flashLabel(target.closest("button"), "Copied"),
      () => flashLabel(target.closest("button"), "Copy failed"),
    );
  }
  if (action === "download-output") downloadOutput(itemId, attempt, checkId);
}

/** Paws Closeout of an item, or the agent's Closeout of a run when the key says so. */
function closeoutVerdict(itemId: string) {
  const runId = agentCloseoutRun(itemId);
  if (runId === null) return snapshot?.verdicts.find((entry) => entry.itemId === itemId);
  const agent = findAgentCloseout(snapshot?.agentCloseout, runId);
  return agent ? agentVerdict(agent) : undefined;
}

function closeoutChecks(itemId: string, attempt: number) {
  const verdict = closeoutVerdict(itemId);
  if (!verdict) return [];
  return attemptsOf(verdict).find((entry) => entry.number === attempt)?.checks ?? [];
}

function flashLabel(button: HTMLButtonElement | null, label: string): void {
  if (!button) return;
  const before = button.textContent;
  button.textContent = label;
  window.setTimeout(() => {
    button.textContent = before;
  }, 1500);
}

/** A copied check link (`#check=<attempt>/<id>`) opens that attempt and row once, then scrolls to it. */
function openLinkedCheck(): boolean {
  const hash = location.hash;
  if (hash === linkedHash) return false;
  const linked = parseCheckHash(hash);
  if (!linked) {
    linkedHash = hash;
    return false;
  }
  const sections = document.querySelectorAll(
    '#page-content section[aria-label="Closeout"] [data-item], #page-content section[aria-label="Agent Closeout"] [data-item]',
  );
  const found = [
    ...new Set([...sections].map((element) => element.getAttribute("data-item") ?? "")),
  ].flatMap((key) => {
    const verdict = closeoutVerdict(key);
    const attempt = verdict
      ? attemptsOf(verdict).find((entry) => entry.number === linked.attempt)
      : undefined;
    return attempt?.checks.some((check) => check.id === linked.checkId) ? [{ key, attempt }] : [];
  })[0];
  if (!found) return false;
  linkedHash = hash;
  const itemId = found.key;
  const attempt = found.attempt;
  if (agentCloseoutRun(itemId) !== null) closeout.open[`section\n${itemId}`] = true;
  closeout.attempt[itemId] = attempt.number;
  closeout.open[checkKey(itemId, attempt.number, linked.checkId)] = true;
  paint();
  document
    .getElementById(checkAnchor(attempt.number, linked.checkId, itemId))
    ?.scrollIntoView({ block: "start" });
  return true;
}

async function paintGitHubAuth(
  device: { userCode: string; verificationUri: string } | null,
): Promise<void> {
  const slot = document.querySelector("#github-auth");
  if (!slot) return;
  const access = await loadGitHubAccess().catch(() => null);
  if (access === null) return;
  renderMarkup(
    slot,
    access.allowed
      ? renderGitHubSignIn({ user: access.user, device: access.user ? null : device })
      : "",
  );
}

async function signInWithGitHub(): Promise<void> {
  const slot = document.querySelector("#github-auth");
  try {
    const device = await startGitHubDevice(readCsrfToken(document));
    if (slot) renderMarkup(slot, renderGitHubSignIn({ user: null, device }));
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => {
        window.setTimeout(resolve, 1500);
      });
      const access = await loadGitHubAccess().catch(() => null);
      if (access === null) continue;
      if (!access.allowed || access.user) {
        if (slot)
          renderMarkup(
            slot,
            access.allowed ? renderGitHubSignIn({ user: access.user, device: null }) : "",
          );
        return;
      }
    }
  } catch {
    await paintGitHubAuth(null);
  }
}

function openDialog(): void {
  sourceDialog.open(sourceHelp());
}

function applyIssueFilter(): void {
  const root = document.querySelector("#content");
  if (!root) return;
  const rows = [...root.querySelectorAll<HTMLElement>("[data-issue-state]")];
  if (!rows.length) return;
  let visible = 0;
  for (const row of rows) {
    const show = issueFilter === "all" || row.dataset.issueState === issueFilter;
    row.hidden = !show;
    if (show) visible += 1;
  }
  const empty = root.querySelector<HTMLElement>(".issue-filter-empty");
  if (empty) empty.hidden = visible > 0;
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-issue-filter]")) {
    const on = button.dataset.issueFilter === issueFilter;
    button.setAttribute("aria-pressed", on ? "true" : "false");
    button.classList.toggle("bg-main", on);
    button.classList.toggle("text-main-foreground", on);
    button.classList.toggle("bg-secondary-background", !on);
    button.classList.toggle("text-foreground", !on);
  }
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

function sourceHelp(): string {
  if (choice.kind === "demo") return "Showing bundled demo data.";
  return "Status comes from this Paws server.";
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

function downloadOutput(itemId: string, attempt: number, checkId: string): void {
  const check = closeoutChecks(itemId, attempt).find((entry) => entry.id === checkId);
  if (!check) return;
  const body = `STDOUT\n${check.stdout ?? ""}\nSTDERR\n${check.stderr ?? ""}\n`;
  const blob = new Blob([body], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${checkId.replace(/[^A-Za-z0-9_-]/g, "_")}-${attempt}.log`;
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
