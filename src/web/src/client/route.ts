import type { StatusSnapshot } from "../contract";
import { SETTINGS_PAGES, type SettingsPage } from "./settings-pages";

export type Route =
  | { view: "overview" }
  | { view: "runners"; id: string | null }
  | { view: "projects" }
  | { view: "issues"; id: string | null }
  | { view: "runs"; id: string | null }
  | { view: "sessions"; id: string | null }
  | { view: "questions"; id: string | null }
  | { view: "settings"; page?: SettingsPage };

export function parseRoute(hash: string, snapshot?: StatusSnapshot | null): Route {
  const parts = hash
    .replace(/^#/, "")
    .split("/")
    .filter((part) => part.length > 0)
    .map(decodePart);
  const head = parts[0];
  const id = parts[1] ?? null;
  switch (head) {
    case undefined:
    case "overview":
      return { view: "overview" };
    case "runners":
      return { view: "runners", id };
    case "projects":
      return { view: "projects" };
    case "issues":
      return { view: "issues", id };
    case "epics":
      return { view: "issues", id: null };
    case "runs":
      return { view: "runs", id };
    case "sessions":
      return { view: "sessions", id };
    case "questions":
      return { view: "questions", id };
    case "verdicts":
      return { view: "runs", id: runForVerdict(id, snapshot) ?? (snapshot ? id : null) };
    case "queue":
      return { view: "overview" };
    case "settings":
      return SETTINGS_PAGES.some((entry) => entry.id === id)
        ? { view: "settings", page: id as SettingsPage }
        : { view: "settings" };
    default:
      return { view: "overview" };
  }
}

export function routeHref(route: Route): string {
  if (route.view === "overview") return "#/";
  if (route.view === "settings") return route.page ? `#/settings/${route.page}` : "#/settings";
  if (route.view === "projects") return "#/projects";
  return route.id ? `#/${route.view}/${encodeURIComponent(route.id)}` : `#/${route.view}`;
}

function runForVerdict(
  id: string | null,
  snapshot: StatusSnapshot | null | undefined,
): string | null {
  if (!id || !snapshot) return null;
  const item = snapshot.items.find((entry) => entry.id === id);
  if (item?.runId && snapshot.runs.some((run) => run.id === item.runId)) return item.runId;
  let match: StatusSnapshot["runs"][number] | undefined;
  for (const run of snapshot.runs) {
    if (run.itemId !== id) continue;
    if (!match || run.startedAt > match.startedAt) match = run;
  }
  return match?.id ?? null;
}

function decodePart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}
