import type { StatusSnapshot } from "../contract";
import { SETTINGS_PAGES, type SettingsPage } from "./settings-pages";

export type Route =
  | { view: "overview" }
  | { view: "runners"; id: string | null }
  | { view: "projects" }
  | { view: "issues"; id: string | null }
  | { view: "runs"; id: string | null }
  | { view: "mergeQueue" }
  | { view: "evidence"; id: string | null }
  | { view: "questions"; id: string | null }
  | { view: "settings"; page?: SettingsPage };

const ENGINE_BASE = "/status";

export function routerBase(pathname: string): string {
  return pathname === ENGINE_BASE || pathname.startsWith(`${ENGINE_BASE}/`) ? ENGINE_BASE : "";
}

export function parseRoute(path: string, snapshot?: StatusSnapshot | null): Route {
  return matchRoute(path, snapshot) ?? { view: "overview" };
}

export function matchRoute(path: string, snapshot?: StatusSnapshot | null): Route | null {
  const parts = path
    .replace(/^#/, "")
    .split("/")
    .filter((part) => part.length > 0)
    .map(decodePart);
  const head = parts[0];
  const id = parts[1] ?? null;
  switch (head) {
    case undefined:
    case "overview":
    case "queue":
      return { view: "overview" };
    case "runners":
      return { view: "runners", id };
    case "projects":
      return { view: "projects" };
    case "issues":
      return { view: "issues", id };
    case "epics":
      return { view: "issues", id: null };
    case "runs": {
      const issue = id === null ? null : issueForRun(id, snapshot);
      return issue ? { view: "issues", id: issue } : { view: "runs", id };
    }
    case "merge-queue":
      return { view: "mergeQueue" };
    case "evidence":
      return { view: "evidence", id };
    case "sessions":
      return { view: "issues", id: id === null ? null : issueForSession(id, snapshot) };
    case "questions":
      return { view: "questions", id };
    case "verdicts":
      return { view: "issues", id: id === null ? null : (issueForVerdict(id, snapshot) ?? id) };
    case "settings":
      return SETTINGS_PAGES.some((entry) => entry.id === id)
        ? { view: "settings", page: id as SettingsPage }
        : { view: "settings" };
    default:
      return null;
  }
}

export function routePath(route: Route): string {
  if (route.view === "overview") return "/";
  if (route.view === "settings") return route.page ? `/settings/${route.page}` : "/settings";
  if (route.view === "projects") return "/projects";
  if (route.view === "mergeQueue") return "/merge-queue";
  return route.id ? `/${route.view}/${encodeURIComponent(route.id)}` : `/${route.view}`;
}

export function routeHref(route: Route): string {
  const page = (globalThis as { location?: { pathname: string } }).location;
  return `${routerBase(page?.pathname ?? "")}${routePath(route)}`;
}

export function needsSnapshot(route: Route): boolean {
  return ["overview", "issues", "runs", "mergeQueue", "questions", "evidence"].includes(route.view);
}

const FOLDED = new Set(["runs", "sessions", "verdicts"]);

/**
 * The issue page a run, session or verdict link now opens, such as `/issues/PAS-367`.
 * A session link the snapshot does not know opens the issue list, since the Conversations
 * page it used to open no longer exists.
 * Null when the path is not one of those, or the snapshot has not arrived yet.
 */
export function issueRedirect(path: string, snapshot: StatusSnapshot | null): string | null {
  if (!snapshot) return null;
  const head = path
    .replace(/^#/, "")
    .split("/")
    .find((part) => part.length > 0);
  if (head === undefined || !FOLDED.has(head)) return null;
  const route = matchRoute(path, snapshot);
  if (route?.view !== "issues") return null;
  return route.id !== null || head === "sessions" ? routePath(route) : null;
}

/** Any of a task's engine run ids, or the run id the dashboard shows for it. */
function issueForRun(id: string, snapshot: StatusSnapshot | null | undefined): string | null {
  const run = snapshot?.runs.find((entry) => entry.id === id || entry.attempts?.includes(id));
  return run?.itemId ?? null;
}

/**
 * The Linear session's issue. Sub-issues that share a session open the one delegated first;
 * items arrive newest first.
 */
function issueForSession(id: string, snapshot: StatusSnapshot | null | undefined): string | null {
  return snapshot?.items.findLast((item) => item.session?.id === id)?.id ?? null;
}

function issueForVerdict(id: string, snapshot: StatusSnapshot | null | undefined): string | null {
  if (!snapshot) return null;
  if (snapshot.items.some((item) => item.id === id)) return id;
  return (
    snapshot.verdicts.find((verdict) => verdict.runId === id)?.itemId ?? issueForRun(id, snapshot)
  );
}

function decodePart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}
