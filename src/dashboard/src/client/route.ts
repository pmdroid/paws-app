import { journalCaught } from "../journal";
import { hasStatusSlice, type StatusSlice, type StatusSnapshot } from "../contract";
import { SETTINGS_PAGES, type SettingsPage } from "./settings-pages";
import { DASHBOARD_PATH, isDashboardPath } from "../../../dashboard-links";
import { isAliasKind, type AliasKind } from "../aliases";

export type Route =
  | { view: "overview" }
  | { view: "runners"; id: string | null }
  | { view: "issues"; id: string | null }
  | { view: "runs"; id: string | null }
  | { view: "alias"; kind: AliasKind; id: string }
  | { view: "mergeQueue" }
  | { view: "findings" }
  | { view: "evidence"; id: string | null }
  | { view: "questions"; id: string | null }
  | { view: "settings"; page?: SettingsPage };

export function routerBase(pathname: string): string {
  return isDashboardPath(pathname) ? DASHBOARD_PATH : "";
}

export function parseRoute(path: string): Route {
  return matchRoute(path) ?? { view: "overview" };
}

export function matchRoute(path: string): Route | null {
  const parts = path
    .replace(/^#/, "")
    .split("/")
    .filter((part) => part.length > 0)
    .map(decodePart);
  const head = parts[0];
  const id = parts[1] ?? null;
  if (isAliasKind(head)) {
    if (id === null) return { view: "issues", id: null };
    return parts.length === 2 ? { view: "alias", kind: head, id } : null;
  }
  switch (head) {
    case undefined:
    case "overview":
    case "queue":
      return { view: "overview" };
    case "runners":
      return { view: "runners", id };
    case "issues":
      return { view: "issues", id };
    case "epics":
      return { view: "issues", id: null };
    case "merge-queue":
      return { view: "mergeQueue" };
    case "findings":
      return { view: "findings" };
    case "evidence":
      return { view: "evidence", id };
    case "questions":
      return { view: "questions", id };
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
  if (route.view === "mergeQueue") return "/merge-queue";
  if (route.view === "findings") return "/findings";
  if (route.view === "alias") return `/${route.kind}/${encodeURIComponent(route.id)}`;
  return route.id ? `/${route.view}/${encodeURIComponent(route.id)}` : `/${route.view}`;
}

export function routeHref(route: Route): string {
  const page = (globalThis as { location?: { pathname: string } }).location;
  return `${routerBase(page?.pathname ?? "")}${routePath(route)}`;
}

export const ROUTE_SLICES: Record<Route["view"], readonly StatusSlice[]> = {
  overview: [],
  issues: [],
  runs: [],
  alias: [],
  mergeQueue: [],
  questions: [],
  evidence: ["items", "evidence"],
  // The Findings page loads `/api/findings` itself.
  findings: [],
  runners: [],
  settings: [],
};

export function routeSlices(route: Route): readonly StatusSlice[] {
  return ROUTE_SLICES[route.view];
}

export function routeCovered(route: Route, snapshot: StatusSnapshot | null): boolean {
  return routeSlices(route).every((slice) => hasStatusSlice(snapshot, slice));
}

export function needsSnapshot(route: Route): boolean {
  return routeSlices(route).length > 0;
}

export type RouteResource =
  | "overview"
  | "issue"
  | "issues"
  | "mergeQueue"
  | "questions"
  | "question"
  | "status"
  | null;

export function routeResource(route: Route): RouteResource {
  if (route.view === "overview") return "overview";
  if (route.view === "issues") return route.id === null ? "issues" : "issue";
  if (route.view === "runs") return "issues";
  if (route.view === "mergeQueue") return "mergeQueue";
  if (route.view === "questions") return route.id === null ? "questions" : "question";
  return needsSnapshot(route) ? "status" : null;
}

export function issueListRedirect(path: string): string | null {
  const parts = path
    .replace(/^#/, "")
    .split("/")
    .filter((part) => part.length > 0);
  return parts.length === 1 && isAliasKind(parts[0]) ? "/issues" : null;
}

function decodePart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch (caughtError1) {
    journalCaught(caughtError1, "route.decodePart.decodeURIComponent", null);
    return part;
  }
}
