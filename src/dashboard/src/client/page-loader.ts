import {
  ISSUES_API_PATH,
  OVERVIEW_API_PATH,
  issuePath,
  parseIssueDetailResponse,
  parseIssueListResponse,
  parseOverviewResponse,
  type IssueDetailResponse,
  type IssueListResponse,
  type OverviewResponse,
  type StatusSnapshot,
} from "../contract";
import { journalCaught } from "../journal";
import { createResourceReader, type ResourceReader } from "./resource-reader";
import { routeResource, routeSlices, type Route } from "./route";
import { createStatusReader } from "./status-reader";

export interface PageResources {
  snapshot: StatusSnapshot | null;
  issues: IssueListResponse | null;
  issue: IssueDetailResponse | null;
  overview: OverviewResponse | null;
}

export type PageLoad = "applied" | "stale" | "signed-out" | { error: string };

export interface PageLoaderOptions {
  reader: () => string;
  signedIn: (response: Response) => Promise<boolean>;
  resources?: ResourceReader;
}

function parseList(input: unknown) {
  const parsed = parseIssueListResponse(input);
  return parsed.ok ? { ok: true as const, body: parsed.response } : parsed;
}

function parseOverview(input: unknown) {
  const parsed = parseOverviewResponse(input);
  return parsed.ok ? { ok: true as const, body: parsed.response } : parsed;
}

function parseDetail(input: unknown) {
  const parsed = parseIssueDetailResponse(input);
  return parsed.ok ? { ok: true as const, body: parsed.response } : parsed;
}

export function createPageLoader(options: PageLoaderOptions) {
  const resources = options.resources ?? createResourceReader();
  const readStatus = createStatusReader(resources);
  const data: PageResources = { snapshot: null, issues: null, issue: null, overview: null };
  let generation = 0;
  let started = 0;
  let applied = 0;

  async function load(route: Route): Promise<PageLoad> {
    const request = ++started;
    const at = generation;
    const reader = options.reader();
    const current = () => at === generation && reader === options.reader() && request > applied;
    const apply = (change: () => void): PageLoad => {
      if (!current()) return "stale";
      applied = request;
      change();
      return "applied";
    };
    const refused = async (response: Response): Promise<PageLoad> => {
      if (!(await options.signedIn(response))) return "signed-out";
      if (!current()) return "stale";
      applied = request;
      return { error: await errorText(response) };
    };
    try {
      const resource = routeResource(route);
      if (resource === "issue" && route.view === "issues" && route.id !== null) {
        const read = await resources.read(issuePath(route.id), reader, parseDetail);
        if (read.kind === "loaded") return apply(() => (data.issue = read.body));
        if (read.response.status !== 404) return await refused(read.response);
        if (!current()) return "stale";
        const list = await resources.read(ISSUES_API_PATH, reader, parseList);
        if (list.kind === "response") return await refused(list.response);
        return apply(() => {
          data.issue = null;
          data.issues = list.body;
        });
      }
      if (resource === "overview") {
        const read = await resources.read(OVERVIEW_API_PATH, reader, parseOverview);
        if (read.kind === "response") return await refused(read.response);
        return apply(() => (data.overview = read.body));
      }
      if (resource === "issues") {
        const list = await resources.read(ISSUES_API_PATH, reader, parseList);
        if (list.kind === "response") return await refused(list.response);
        return apply(() => (data.issues = list.body));
      }
      if (resource === "status") {
        const read = await readStatus(routeSlices(route), reader);
        if (read.kind === "response") return await refused(read.response);
        return apply(() => (data.snapshot = read.snapshot));
      }
      return "stale";
    } catch (caught) {
      journalCaught(caught, "pageLoader.load.fetch", null);
      if (!current()) return "stale";
      applied = request;
      return { error: caught instanceof Error ? caught.message : "Could not load status" };
    }
  }

  return {
    data,
    load,
    navigate(): void {
      generation += 1;
    },
    reset(): void {
      generation += 1;
      resources.clear();
      data.snapshot = null;
      data.issues = null;
      data.issue = null;
      data.overview = null;
    },
  };
}

export async function errorText(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
      return `Engine responded ${response.status}: ${body.error}`;
    }
  } catch (caughtError3) {
    journalCaught(caughtError3, "pageLoader.errorText.json", null);
  }
  return `Engine responded ${response.status}`;
}
