import { journalCaught } from "../journal";
import { renderMarkup } from "./theme";
import { mountShell } from "./shell";
import { mergeQueueCount } from "./merge-queue";

import {
  parseStatusCheckLog,
  parseStatusItemDetail,
  parseStatusSnapshot,
  statusCheckLogPath,
  statusItemPath,
  type StatusCheckLog,
  type StatusItemDetail,
  type StatusSnapshot,
} from "../contract";
import {
  attemptsOf,
  checkAnchor,
  checkHash,
  checkKey,
  emptyCloseoutView,
  isOpen,
  parseCheckHash,
  type CheckLogView,
} from "./closeout";
import { captureLogs, restoreLogs } from "./log-scroll";
import { agentCloseoutRun, agentVerdict, findAgentCloseout } from "./agent-closeout";
import { issueRowMatches, openDetail, render, type RenderModel } from "./render";
import {
  issueRedirect,
  matchRoute,
  needsSnapshot,
  parseRoute,
  routerBase,
  type Route,
} from "./route";
import type { SettingsPage } from "./settings-pages";

import { createAgentSettings } from "./agent-settings";
import { createSkillSettings } from "./skills";
import { createMergeSettings } from "./merge-settings";
import { createHookSettings } from "./hooks";
import { createCheckoutSettings } from "./checkout-settings";
import { createSessionStart } from "./session-start";
import { createRunners } from "./runners";
import { createExecutionControls } from "./execution-controls";
import { linkAskAnchor } from "./link-ask";
import { rememberLinkAskDraft, stopFromLinkAsk, submitLinkAsk } from "./link-ask-submit";
import { clickVisualReviewAsk, submitVisualReviewAsk } from "./visual-review-ask";
import { createDeadDeliveryRetry } from "./dead-delivery-retry";
import { createReviewDraw } from "./review-draw";
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
const skillSettings = createSkillSettings();
const mergeSettings = createMergeSettings(() => paint());
const hookSettings = createHookSettings();
const checkoutSettings = createCheckoutSettings();
const sessionStart = createSessionStart(reload);
const runners = createRunners();
const executionControls = createExecutionControls(reload);
const deadDeliveryRetry = createDeadDeliveryRetry(reload);
const reviewDraw = createReviewDraw(reload);
const evidence = createEvidenceMedia(() => paint());

const POLL_MS = 5000;

const regions = ["#top", "#banner", "#page-content"] as const;
const painted = new Map<string, string>();

const closeout = emptyCloseoutView();
let linkedHash = "";
/** The path and hash of the link ask card last scrolled to, so a repaint does not scroll again. */
let linkedCard = "";
let phase: RenderModel["phase"] = "loading";
let snapshot: StatusSnapshot | null = null;
/** The open issue page's data. While an issue page is open, only this is polled. */
let detail: StatusItemDetail | null = null;
let error: string | null = null;
let timer = 0;
let workspaceReady = false;
let booted = false;
let shownPath = router.state.location.pathname;
let shownSearch = router.state.location.search;

let issueFilter: "all" | "active" | "needs" | "done" = "all";
/** A Linear project id, `none` for issues without one, or empty for any project. */
let issueProject = "";

document.addEventListener("click", onClick);
document.addEventListener("submit", (event) => {
  if (!submitVisualReviewAsk(event, reload)) submitLinkAsk(event, reload);
});
document.addEventListener("input", (event) => rememberLinkAskDraft(event.target));
document.addEventListener("change", (event) => rememberLinkAskDraft(event.target));
router.subscribe((state) => {
  if (state.location.pathname === shownPath) {
    if (state.location.search === shownSearch) return;
    shownSearch = state.location.search;
    paint();
    return;
  }
  shownPath = state.location.pathname;
  shownSearch = state.location.search;
  routeChanged();
  window.scrollTo({ top: 0, behavior: "instant" });
  document.querySelector<HTMLElement>("#content")?.focus({ preventScroll: true });
});
document.addEventListener("change", (event) => {
  const target = event.target;
  if (target instanceof HTMLSelectElement && target.dataset.issueProjectFilter !== undefined) {
    issueProject = target.value;
    applyIssueFilter();
    return;
  }
  if (!(target instanceof HTMLSelectElement) || target.dataset.routePicker === undefined) return;
  const path = appPath(target.value);
  if (path !== null && ["issues", "runs"].includes(parseRoute(path).view))
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
  } catch (caughtError1) {
    journalCaught(caughtError1, "main.boot.getItem", null);
  }
  booted = true;
  phase = "loading";
  paint();
  await reload();
}

function routeChanged(): void {
  const issue = openIssue(currentRoute());
  // A newly opened issue page waits for its own detail instead of showing list data.
  if (issue !== null && detail?.id !== issue) phase = "loading";
  paint();
  if (!booted) return;
  void reload();
}

async function reload(): Promise<void> {
  const route = currentRoute();
  if (!needsSnapshot(route)) {
    schedule();
    return;
  }
  try {
    const loaded = await loadDetail(route);
    if (loaded === "signed-out") return;
    if (loaded === "none") {
      const response = await fetch("/api/status", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!(await signedIn(response))) return;
      if (!response.ok) throw new Error(await errorText(response));
      const parsed = parseStatusSnapshot(await response.json());
      if (!parsed.ok) throw new Error(parsed.error);
      snapshot = parsed.snapshot;
    }
    phase = "ready";
    error = null;
  } catch (caught) {
    journalCaught(caught, "main.reload.fetch", null);
    error = caught instanceof Error ? caught.message : "Could not load status";
    phase = "error";
  }
  paint();
  schedule();
}

function openIssue(route: Route): string | null {
  return route.view === "issues" ? route.id : null;
}

/**
 * Loads the open issue page's detail. `none` when no issue page is open or the issue is not
 * visible, so the list snapshot is loaded instead and the page says the issue was not found.
 */
async function loadDetail(route: Route): Promise<"loaded" | "none" | "signed-out"> {
  const id = openIssue(route);
  if (id === null) return "none";
  const response = await fetch(statusItemPath(id), {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!(await signedIn(response))) return "signed-out";
  if (response.status === 404) {
    detail = null;
    return "none";
  }
  if (!response.ok) throw new Error(await errorText(response));
  const parsed = parseStatusItemDetail(await response.json());
  if (!parsed.ok) throw new Error(parsed.error);
  // The reader may have moved to another page while this request ran.
  if (openIssue(currentRoute()) === id) detail = parsed.detail;
  return "loaded";
}

/** False when the session ended and the reader still has to sign in again. */
async function signedIn(response: Response): Promise<boolean> {
  if (response.status !== 401) return true;
  workspaceReady = await initializeWorkspaceAccess(() => settingsPage(currentRoute()));
  shell.setAuthenticated(workspaceReady);
  return workspaceReady;
}

/** What the current page renders from: the issue's detail on its page, otherwise the list. */
function pageData(): StatusSnapshot | null {
  return openDetail({ route: currentRoute(), detail }) ? detail : snapshot;
}

/** Run, session and verdict links open the issue page, so links posted in Linear keep working. */
function followIssueRedirect(): boolean {
  const pathname = router.state.location.pathname;
  const target = issueRedirect(pathname.slice(routerBase(pathname).length), snapshot);
  if (target === null) return false;
  void router.navigate(`${target}${router.state.location.search}${location.hash}`, {
    replace: true,
  });
  return true;
}

function schedule(): void {
  window.clearInterval(timer);
  const route = currentRoute();
  if (!needsSnapshot(route)) return;
  // Stored evidence does not change, and a repaint would interrupt the video.
  if (route.view === "evidence") return;
  timer = window.setInterval(() => {
    void reload();
  }, POLL_MS);
}

function paint(): void {
  if (!workspaceReady) return;
  if (phase === "ready" && followIssueRedirect()) return;
  const model: RenderModel = {
    route: currentRoute(),
    phase,
    snapshot,
    detail,
    error,
    engineUrl: currentEngine(),
    closeout,
    mediaInfo: evidence.info,
  };
  const view = render(model);
  const route = model.route;
  const data = pageData();
  const shown =
    route.view === "evidence" ? snapshot?.evidence?.find((entry) => entry.id === route.id) : null;
  if (snapshot) shell.setCounts({ mergeQueue: mergeQueueCount(snapshot) });
  shell.setBreadcrumb(
    shown
      ? { issueId: shown.itemId, entityId: shown.id }
      : (model.route.view === "evidence" || model.route.view === "issues") && model.route.id
        ? { issueId: null, entityId: model.route.id }
        : null,
  );
  const showSettings = model.route.view === "settings";
  const access = document.querySelector<HTMLElement>("#workspace-access");
  if (access && access.dataset.loaded === "true")
    access.hidden =
      !showSettings ||
      model.route.view !== "settings" ||
      ["agents", "merging"].includes(model.route.page ?? "agents");
  showWorkspaceSettingsPage(
    model.route.view === "settings" ? (model.route.page ?? "agents") : null,
  );
  document.title = view.title;
  setHtml("#top", view.top);
  setHtml("#banner", view.banner);
  setHtml("#page-content", view.content);
  evidence.attach(data, currentEngine());
  applyIssueFilter();
  if (openLinkedCheck()) return;
  scrollToLinkedCard();

  const settingsRoot = document.querySelector<HTMLElement>("#agent-settings");
  if (settingsRoot) settings.mount(settingsRoot, currentEngine());
  const checkoutRoot = document.querySelector<HTMLElement>("#checkout-settings");
  if (checkoutRoot) checkoutSettings.mount(checkoutRoot, currentEngine());
  const skillsRoot = document.querySelector<HTMLElement>("#skill-settings");
  if (skillsRoot) skillSettings.mount(skillsRoot, currentEngine());
  const mergeRoot = document.querySelector<HTMLElement>("#merge-settings");
  if (mergeRoot) mergeSettings.mount(mergeRoot, currentEngine());
  const hooksRoot = document.querySelector<HTMLElement>("#hook-settings");
  if (hooksRoot) hookSettings.mount(hooksRoot, currentEngine());
  const sessionRoot = document.querySelector<HTMLElement>("#linear-session-start");
  if (sessionRoot)
    sessionStart.mount(
      sessionRoot,
      currentEngine(),
      source(),
      model.route.view === "issues" && model.route.id === null,
    );
  const executionRoot = document.querySelector<HTMLElement>("#execution-controls");
  if (executionRoot) executionControls.mount(executionRoot, currentEngine(), source());
  const deadRoot = document.querySelector<HTMLElement>("#dead-deliveries");
  if (deadRoot) deadDeliveryRetry.mount(deadRoot, currentEngine(), source());
  const drawRoot = document.querySelector<HTMLElement>("#review-draw");
  if (drawRoot) reviewDraw.mount(drawRoot, data, currentEngine(), source());
  const runnerRoot = document.querySelector<HTMLElement>("#runner-settings");
  if (runnerRoot && model.route.view === "runners")
    runners.mount(runnerRoot, currentEngine(), source(), model.route.id);
  if (loadOpenLogs()) paint();
}

/** Screenshots from this origin can have marks drawn into them. */
function drawsLocally(): boolean {
  return new URL(currentEngine()).origin === location.origin && source() === "live";
}

function currentRoute(): Route {
  const pathname = router.state.location.pathname;
  return parseRoute(pathname.slice(routerBase(pathname).length), snapshot);
}

function settingsPage(route: Route): SettingsPage | null {
  return route.view === "settings" ? (route.page ?? "agents") : null;
}

function source(): string {
  return "live";
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
  void router.navigate(`${path}${new URL(link.href).hash}`);
}

/** A link ask link (`/status/issues/PAS-633#risk`) scrolls to its card once the card is drawn. */
function scrollToLinkedCard(): void {
  const key = `${location.pathname}${location.hash}`;
  if (!linkAskAnchor(location.hash) || key === linkedCard) return;
  const card = document.getElementById(location.hash.slice(1));
  if (card === null) return;
  linkedCard = key;
  card.scrollIntoView({ block: "start" });
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

function onClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (clickVisualReviewAsk(event, drawsLocally(), reload)) return;
  followLink(event, target);
  if (stopFromLinkAsk(event, reload)) return;
  const action = target.closest("[data-action]")?.getAttribute("data-action");
  if (!action) return;
  if (action === "refresh") {
    void reload();
    if (currentRoute().view === "runners") void runners.refresh();
  }
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
      (caughtError1) => {
        journalCaught(caughtError1, "main.onClick.writeText", itemId);
        return flashLabel(target.closest("button"), "Copy failed");
      },
    );
  }
  if (action === "check-log-full") {
    const check = closeoutChecks(itemId, attempt).find((entry) => entry.id === checkId);
    if (check) void loadLog(itemId, attempt, checkId, check.state, true);
  }
  if (action === "download-output") void downloadOutput(itemId, attempt, checkId);
}

/**
 * Starts loading the log of every open check row on the issue page that has none for the
 * check's current state. Polling repaints do not load a log again. True when one started.
 */
function loadOpenLogs(): boolean {
  if (openIssue(currentRoute()) === null) return false;
  let started = false;
  const rows = document.querySelectorAll<HTMLElement>(
    '#page-content [data-action="toggle-check"][aria-expanded="true"]',
  );
  for (const row of rows) {
    const itemId = row.dataset.item ?? "";
    const attempt = Number(row.dataset.attempt ?? "");
    const checkId = row.dataset.check ?? "";
    const check = closeoutChecks(itemId, attempt).find((entry) => entry.id === checkId);
    // Evidence rows show no output, and a pending check has none yet.
    if (!check || check.kind === "evidence" || check.state === "pending") continue;
    if (closeout.logs?.[checkKey(itemId, attempt, checkId)]?.checkState === check.state) continue;
    void loadLog(itemId, attempt, checkId, check.state);
    started = true;
  }
  return started;
}

async function loadLog(
  itemId: string,
  attempt: number,
  checkId: string,
  checkState: string,
  full = false,
): Promise<void> {
  const key = checkKey(itemId, attempt, checkId);
  const logs = (closeout.logs ??= {});
  const loading: CheckLogView = { status: "loading", checkState };
  logs[key] = loading;
  let next: CheckLogView;
  try {
    const log = await fetchLog(itemId, attempt, checkId, full);
    if (log === null) return;
    next = { status: "loaded", checkState, ...log, full };
  } catch (caught) {
    journalCaught(caught, "main.loadLog.fetch", itemId);
    next = {
      status: "error",
      checkState,
      error: caught instanceof Error ? caught.message : "Could not load the log",
    };
  }
  // A later load of the same row replaced this one.
  if (logs[key] !== loading) return;
  logs[key] = next;
  paint();
}

/** One check's log from the open issue page's item. Null when the reader is signed out. */
async function fetchLog(
  itemId: string,
  attempt: number,
  checkId: string,
  full: boolean,
): Promise<StatusCheckLog | null> {
  const issue = openIssue(currentRoute());
  if (issue === null) throw new Error("No issue page is open");
  const path = statusCheckLogPath(issue, attempt, checkId, {
    run: agentCloseoutRun(itemId),
    full,
  });
  const response = await fetch(path, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!(await signedIn(response))) return null;
  if (!response.ok) throw new Error(await errorText(response));
  const parsed = parseStatusCheckLog(await response.json());
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.log;
}

function closeoutVerdict(itemId: string) {
  const data = pageData();
  const runId = agentCloseoutRun(itemId);
  if (runId === null) return data?.verdicts.find((entry) => entry.itemId === itemId);
  const agent = findAgentCloseout(data?.agentCloseout, runId);
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

function applyIssueFilter(): void {
  const root = document.querySelector("#content");
  if (!root) return;
  const rows = [...root.querySelectorAll<HTMLElement>("[data-issue-state]")];
  if (!rows.length) return;
  const picker = root.querySelector<HTMLSelectElement>("select[data-issue-project-filter]");
  if (picker) {
    if (![...picker.options].some((option) => option.value === issueProject)) issueProject = "";
    picker.value = issueProject;
  } else issueProject = "";
  let visible = 0;
  for (const row of rows) {
    const show = issueRowMatches(
      { state: row.dataset.issueState, project: row.dataset.issueProject },
      { state: issueFilter, project: issueProject },
    );
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

function currentEngine(): string {
  return location.origin;
}

async function errorText(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
      return `Engine responded ${response.status}: ${body.error}`;
    }
  } catch (caughtError3) {
    journalCaught(caughtError3, "main.errorText.json", null);
    /* status is enough */
  }
  return `Engine responded ${response.status}`;
}

async function downloadOutput(itemId: string, attempt: number, checkId: string): Promise<void> {
  const check = closeoutChecks(itemId, attempt).find((entry) => entry.id === checkId);
  if (!check) return;
  let streams = { stdout: check.stdout ?? "", stderr: check.stderr ?? "" };
  try {
    const log = await fetchLog(itemId, attempt, checkId, true);
    if (log === null) return;
    streams = log;
  } catch (caught) {
    journalCaught(caught, "main.downloadOutput.fetchLog", itemId);
    const loaded = closeout.logs?.[checkKey(itemId, attempt, checkId)];
    if (loaded?.status === "loaded") streams = loaded;
  }
  const body = `STDOUT\n${streams.stdout}\nSTDERR\n${streams.stderr}\n`;
  const blob = new Blob([body], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${checkId.replace(/[^A-Za-z0-9_-]/g, "_")}-${attempt}.log`;
  link.click();
  URL.revokeObjectURL(url);
}
