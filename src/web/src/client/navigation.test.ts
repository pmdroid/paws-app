import { expect, test } from "bun:test";
import { SETTINGS_PAGES } from "./settings-pages";
import { NAVIGATION, PAGES } from "./navigation";
import { matchRoute, needsSnapshot, parseRoute, routeHref, routerBase, type Route } from "./route";
import { render } from "./render";
import { demoStatus } from "../demo";

const model = {
  phase: "ready" as const,
  snapshot: demoStatus(),
  via: "bundled" as const,
  error: null,
  engineUrl: null,
};

test("sidebar exposes every page exactly once and all page links round-trip", () => {
  const views = NAVIGATION.flatMap((group) => [...group.views]);
  // Settings has its own menu, and an evidence page is opened from a run or a copied link.
  const linked = Object.keys(PAGES).filter(
    (view) => !["settings", "evidence", "runs"].includes(view),
  );
  expect(new Set(views).size).toBe(linked.length);
  expect(views.length).toBe(linked.length);
  for (const view of views) {
    const route = { view, id: null } as Route;
    expect(parseRoute(routeHref(route)).view).toBe(view);
  }
  for (const page of SETTINGS_PAGES) {
    const route: Route = { view: "settings", page: page.id };
    expect(parseRoute(routeHref(route))).toEqual(route);
    const result = render({ ...model, route });
    expect(result.content).toContain(`<h1 class="sr-only">${page.name}</h1>`);
    expect(result.content).not.toContain("settings-navigation");
    expect(result.title).toContain(page.name);
  }
});

test("empty pages retain their own heading and empty state", () => {
  const snapshot = {
    ...demoStatus(),
    items: [],
    runs: [],
    questions: [],
    verdicts: [],
    mergeQueue: [],
  };
  for (const view of ["overview", "issues", "runs", "questions", "sessions"] as const) {
    const html = render({
      ...model,
      snapshot,
      route: { view, id: null },
      conversations: { state: "ready", sessions: [] },
    }).content;
    expect(html.match(/<h1 /g)?.length).toBe(1);
    expect(html).toContain(`<h1 class="sr-only">${PAGES[view].title}</h1>`);
    expect(html).toContain('class="empty"');
  }
});

test("invalid detail routes do not silently show a different result", () => {
  for (const view of ["issues", "runs"] as const) {
    const html = render({ ...model, route: { view, id: "missing" } }).content;
    expect(html).toContain("not found");
    expect(html).toContain("data-route-picker");
  }
});

test("issues list offers state filters and a simple item list", () => {
  const list = render({ ...model, route: { view: "issues", id: null } }).content;
  expect(list).toContain('data-issue-filter="all"');
  expect(list).toContain('data-issue-filter="active"');
  expect(list).toContain('data-issue-filter="needs"');
  expect(list).toContain('data-issue-filter="done"');
  expect(list).toContain("data-issue-state=");
  expect(list).not.toContain("data-view-tabs");
  const detail = render({ ...model, route: { view: "issues", id: "ENG-104" } }).content;
  expect(detail).toContain('<a href="/issues">Issues</a>');
  expect(detail).not.toContain("Linear agent session");
});

test("path routes keep the engine base and only claim dashboard pages", () => {
  expect(routerBase("/status")).toBe("/status");
  expect(routerBase("/status/runs/r-1")).toBe("/status");
  expect(routerBase("/statuses")).toBe("");
  expect(routerBase("/runs/r-1")).toBe("");
  expect(routeHref({ view: "runs", id: "r/1" })).toBe("/runs/r%2F1");
  expect(parseRoute("/runs/r%2F1")).toEqual({ view: "runs", id: "r/1" });
  expect(parseRoute("#/settings/account")).toEqual({ view: "settings", page: "account" });
  expect(matchRoute("/auth/linear")).toBeNull();
  expect(matchRoute("/api/status")).toBeNull();
  expect(matchRoute("/assets/app.js")).toBeNull();
  expect(parseRoute("/unknown")).toEqual({ view: "overview" });
});

test("only work pages read the status snapshot", () => {
  const pages = Object.keys(PAGES).filter((view) => needsSnapshot({ view, id: null } as Route));
  expect(pages).toEqual(["overview", "issues", "runs", "mergeQueue", "evidence", "questions"]);
});
