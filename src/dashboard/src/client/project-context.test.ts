import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ContextView, ContextViewRecord } from "../project-context";
import {
  contextQuery,
  contextSearch,
  createProjectContext,
  renderContext,
  type ContextState,
} from "./project-context";
import { matchRoute, routePath } from "./route";
import { createContextProjects } from "./context-projects";
import { NAVIGATION } from "./navigation";
import { settleReactWork } from "./settle-react";

const ORIGIN = "http://127.0.0.1:8787";
const DOM_GLOBALS = [
  "window",
  "navigator",
  "location",
  "Node",
  "Element",
  "Event",
  "MouseEvent",
  "document",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLFormElement",
  "HTMLInputElement",
  "FormData",
  "addEventListener",
  "removeEventListener",
] as const;
const saved = new Map<string, unknown>();
let window: Window;

const record = (id: string, text: string, extra: Partial<ContextViewRecord> = {}) =>
  ({
    id,
    version: 1,
    classification: "reported_fact",
    text,
    status: "current",
    corrected: false,
    observedAt: Date.parse("2026-11-17T12:00:00Z"),
    source: {
      kind: "linear_project_document",
      id: "doc",
      url: "https://linear.app/d",
      revision: "rev-1",
    },
    ...extra,
  }) satisfies ContextViewRecord;

function contextView(name: string, records: ContextViewRecord[] = []): ContextView {
  return {
    scope: { kind: "project", id: `id-${name}`, name, url: "https://linear.app/p" },
    updatedAt: Date.parse("2026-11-17T12:00:00Z"),
    summaries: [
      {
        version: 3,
        builtAt: Date.parse("2026-11-17T12:00:00Z"),
        state: "stale",
        body: `${name} summary`,
        covered: 2,
        decisions: 1,
        questions: 1,
        sources: [records[0]?.source ?? record("x", "x").source],
      },
    ],
    decisions: [record("d", "Ship project scope first", { classification: "decision" })],
    questions: [record("q", "Reuse for Slack?", { classification: "unresolved_question" })],
    records,
    page: { offset: 0, limit: 25, search: "", more: false },
  };
}

const state = (patch: Partial<ContextState>): ContextState => ({
  query: contextQuery(""),
  phase: "ready",
  view: contextView("Alpha", [record("r1", "Fact one")]),
  detail: null,
  ...patch,
});

beforeEach(() => {
  window = new Window({ url: `${ORIGIN}/dashboard/context/project/alpha` });
  for (const name of DOM_GLOBALS) {
    saved.set(name, (globalThis as Record<string, unknown>)[name]);
    const value = (window as unknown as Record<string, unknown>)[name];
    (globalThis as Record<string, unknown>)[name] =
      name === "window"
        ? window
        : typeof value === "function" && name.endsWith("EventListener")
          ? value.bind(window)
          : value;
  }
});

afterEach(async () => {
  await settleReactWork();
  for (const [name, value] of saved) (globalThis as Record<string, unknown>)[name] = value;
  saved.clear();
  await window.happyDOM.close();
});

test("the context route and its query survive a round trip through the address", () => {
  const route = matchRoute("/context/project/abc-1")!;
  expect(route).toEqual({ view: "context", kind: "project", id: "abc-1" });
  expect(routePath(route)).toBe("/context/project/abc-1");
  expect(matchRoute("/context/channel/C1")).toBeNull();
  expect(matchRoute("/context/project")).toBeNull();
  const query = { tab: "records" as const, q: "slack", offset: 25, record: "r1" };
  expect(contextQuery(contextSearch(query))).toEqual(query);
  expect(contextQuery("?record=<x>&offset=-3").record).toBeNull();
});

test("a populated view labels the summary, its state, open items, superseded records and stays read-only", () => {
  const html = renderContext(
    state({
      query: { ...contextQuery(""), tab: "records" },
      view: contextView("Alpha", [
        record("r1", "Old <script>alert(1)</script>", { status: "superseded" }),
        record("r2", "Fixed", {
          corrected: true,
          source: { kind: "paws_work_item", id: "i", url: "javascript:alert(1)", revision: "r" },
        }),
      ]),
    }),
  );
  expect(html).toContain("Superseded");
  expect(html).toContain("Corrected");
  expect(html).toContain("Read-only");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("javascript:");
  expect(html).toContain("Records covered");
  for (const word of [
    ">Edit<",
    ">Forget<",
    ">Regenerate<",
    ">Delete<",
    ">Delegate<",
    ">Run<",
    ">Export<",
  ])
    expect(html).not.toContain(word);
  const summary = renderContext(state({}));
  expect(summary).toContain("not the exact prompt any agent received");
  expect(summary).toContain("Stale");
  expect(summary).toContain("Ship project scope first");
  expect(summary).toContain("Reuse for Slack?");
});

test("loading, empty, empty search, error and unavailable states are distinct and carry no data", () => {
  const empty = contextView("Alpha", []);
  const records = { ...contextQuery(""), tab: "records" as const };
  expect(renderContext(state({ query: records, view: empty }))).toContain(
    "has not retained context for this project",
  );
  expect(
    renderContext(
      state({ query: records, view: { ...empty, page: { ...empty.page, search: "zzz" } } }),
    ),
  ).toContain("No records match this search.");
  const loading = renderContext(state({ phase: "loading" }));
  expect(loading).toContain('role="status"');
  const error = renderContext(state({ phase: "error" }));
  expect(error).toContain('role="alert"');
  expect(error).toContain("Retry");
  const unavailable = renderContext(state({ phase: "unavailable" }));
  for (const html of [loading, error, unavailable]) {
    expect(html).not.toContain("Alpha");
    expect(html).not.toContain("Fact one");
  }
});

type Pending = { url: string; resolve: (response: Response) => void };

function mounted() {
  const pending: Pending[] = [];
  const methods: string[] = [];
  let search = "";
  const fetcher = ((url: URL, init?: RequestInit) => {
    methods.push(init?.method ?? "GET");
    return new Promise<Response>((resolve) =>
      pending.push({ url: url.pathname + url.search, resolve }),
    );
  }) as unknown as typeof fetch;
  const pages: string[] = [];
  const root = window.document.createElement("div") as unknown as HTMLElement;
  window.document.body.append(root as never);
  const context = createProjectContext({
    fetch: fetcher,
    search: () => search,
    go: (next) => {
      pages.push(next);
      search = next;
    },
  });
  const answer = async (index: number, body: unknown, status = 200) => {
    pending[index]!.resolve(Response.json(body, { status }));
    await settleReactWork();
  };
  return {
    root,
    context,
    pending,
    pages,
    methods,
    answer,
    setSearch: (next: string) => (search = next),
    mount: (id: string) => context.mount(root, ORIGIN, { view: "context", kind: "project", id }),
  };
}

test("switching scope clears old data at once and ignores the old scope's late answer", async () => {
  const page = mounted();
  page.mount("alpha");
  await page.answer(0, { status: "ok", view: contextView("Alpha", [record("a", "Alpha fact")]) });
  expect(page.root.textContent).toContain("Alpha summary");
  page.setSearch("?offset=25");
  page.mount("alpha");
  page.mount("beta");
  expect(page.root.textContent).not.toContain("Alpha");
  expect(page.root.textContent).toContain("Loading project context");
  await page.answer(2, { status: "ok", view: contextView("Beta", [record("b", "Beta fact")]) });
  await page.answer(1, { status: "ok", view: contextView("Late", [record("a", "Alpha late")]) });
  expect(page.root.textContent).toContain("Beta summary");
  expect(page.root.textContent).not.toContain("Late");
  expect(page.pending.map((request) => request.url)).toEqual([
    "/api/context/project/alpha",
    "/api/context/project/alpha?offset=25",
    "/api/context/project/beta?offset=25",
  ]);
  expect(new Set(page.methods)).toEqual(new Set(["GET"]));
  page.context.leave();
});

test("tabs, provenance and pages go through the address, and a repeat click closes provenance", async () => {
  const page = mounted();
  page.mount("alpha");
  await page.answer(0, { status: "ok", view: contextView("Alpha", [record("a", "Alpha fact")]) });
  const click = (selector: string) =>
    (page.root.querySelector(selector) as unknown as HTMLElement).click();
  click('[data-context-tab="records"]');
  expect(page.pages.at(-1)).toBe("?tab=records");
  page.mount("alpha");
  click('[data-context-record="a"]');
  expect(page.pages.at(-1)).toBe("?tab=records&record=a");
  page.mount("alpha");
  await page.answer(1, {
    status: "ok",
    detail: {
      record: {
        ...record("a", "Alpha fact"),
        body: "Alpha fact in full",
        actorId: "u1",
        correctedBy: null,
      },
      versions: [],
    },
  });
  expect(page.root.textContent).toContain("Alpha fact in full");
  expect(page.pending).toHaveLength(2);
  click('[data-context-record="a"]');
  expect(page.pages.at(-1)).toBe("?tab=records");
  page.mount("alpha");
  expect(page.root.textContent).not.toContain("Alpha fact in full");
  page.context.leave();
});

test("an error offers Retry, and a revoked scope on retry shows unavailable without the old data", async () => {
  const page = mounted();
  page.mount("alpha");
  await page.answer(0, { status: "error" }, 503);
  expect(page.root.textContent).toContain("Could not load project context");
  (page.root.querySelector('[data-context-action="retry"]') as unknown as HTMLElement).click();
  await page.answer(1, {
    status: "ok",
    view: contextView("Alpha", [record("a", "Alpha summary")]),
  });
  expect(page.root.textContent).toContain("Alpha summary");
  window.dispatchEvent(Object.assign(new window.Event("pageshow"), { persisted: true }) as never);
  expect(page.root.textContent).not.toContain("Alpha summary");
  await page.answer(2, { status: "unavailable" }, 404);
  expect(page.root.textContent).toContain("Context unavailable");
  expect(page.root.textContent).not.toContain("Alpha");
  page.context.leave();
});

test("the sidebar entry opens the project list, and a row opens that project's page", async () => {
  const manage = NAVIGATION.find((group) => group.label === "Manage")!;
  expect(manage.views).toContain("context");
  const list = matchRoute(routePath({ view: "context", kind: "projects" }))!;
  expect(list).toEqual({ view: "context", kind: "projects" });
  const urls: string[] = [];
  let body: unknown = { status: "ok", projects: [] };
  const fetcher = (async (url: URL) => {
    urls.push(url.pathname);
    return Response.json(body);
  }) as unknown as typeof fetch;
  const root = window.document.createElement("div") as unknown as HTMLElement;
  const projects = createContextProjects({ fetch: fetcher });
  projects.mount(root, ORIGIN);
  await settleReactWork();
  expect(root.textContent).toContain(
    "No projects yet. Paws lists a project here once it works on one of its issues.",
  );
  projects.leave();
  body = { status: "ok", projects: [{ id: "alpha-1", name: "Alpha", items: 3 }] };
  projects.mount(root, ORIGIN);
  await settleReactWork();
  expect(urls).toEqual(["/api/context/projects", "/api/context/projects"]);
  expect(root.textContent).toContain("3 issues");
  const href = root.querySelector("a")!.getAttribute("href")!;
  expect(root.querySelector("a")!.textContent).toBe("Alpha");
  expect(matchRoute(href.replace(/^\/dashboard/, ""))).toEqual({
    view: "context",
    kind: "project",
    id: "alpha-1",
  });
  projects.leave();
});
