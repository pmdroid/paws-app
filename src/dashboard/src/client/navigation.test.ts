import {
  fullStatusFixture,
  issueList,
  listResponse,
  pageData,
  statusFixture,
  statusList,
} from "../../test/fixtures";
import { expect, test } from "bun:test";
import { SETTINGS_PAGES } from "./settings-pages";
import { NAVIGATION, PAGES } from "./navigation";
import {
  issueListRedirect,
  matchRoute,
  needsSnapshot,
  parseRoute,
  ROUTE_SLICES,
  routeCovered,
  routeHref,
  routeResource,
  routerBase,
  type Route,
} from "./route";
import { render } from "./render";
import { STATUS_SLICES } from "../contract";

const model = {
  phase: "ready" as const,
  snapshot: statusList(fullStatusFixture()),
  issues: issueList(fullStatusFixture()),
  error: null,
  engineUrl: null,
};

test("sidebar exposes every page exactly once and all page links round-trip", () => {
  const views = NAVIGATION.flatMap((group) => [...group.views]);
  // Settings has its own menu, and an evidence page is opened from a run or a copied link.
  const linked = Object.keys(PAGES).filter(
    (view) => !["settings", "evidence", "runs", "alias"].includes(view),
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
    ...statusFixture(),
    items: [],
    runs: [],
    questions: [],
    verdicts: [],
    mergeQueue: [],
  };
  for (const view of ["overview", "issues", "runs", "questions"] as const) {
    const html = render({
      ...model,
      snapshot,
      issues: listResponse(snapshot),
      route: { view, id: null },
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
  const detail = render({
    ...model,
    ...pageData(fullStatusFixture(), { view: "issues", id: "ENG-104" }),
  }).content;
  expect(detail).toContain('<a href="/issues">Issues</a>');
  expect(detail).not.toContain("Linear agent session");
});

test("path routes keep the engine base and only claim dashboard pages", () => {
  expect(routerBase("/dashboard")).toBe("/dashboard");
  expect(routerBase("/dashboard/runs/r-1")).toBe("/dashboard");
  expect(routerBase("/dashboards")).toBe("");
  expect(routerBase("/status/runs/r-1")).toBe("");
  expect(routerBase("/runs/r-1")).toBe("");
  expect(routeHref({ view: "runs", id: "r/1" })).toBe("/runs/r%2F1");
  expect(parseRoute("/runs/r%2F1")).toEqual({ view: "alias", kind: "runs", id: "r/1" });
  expect(routeHref({ view: "alias", kind: "sessions", id: "s/1" })).toBe("/sessions/s%2F1");
  expect(parseRoute("#/settings/account")).toEqual({ view: "settings", page: "account" });
  expect(matchRoute("/auth/linear")).toBeNull();
  expect(matchRoute("/api/status")).toBeNull();
  expect(matchRoute("/assets/app.js")).toBeNull();
  expect(parseRoute("/unknown")).toEqual({ view: "overview" });
});

test("the Conversations page is gone and its old links open the issue list", () => {
  expect(Object.keys(PAGES)).not.toContain("sessions");
  expect(NAVIGATION.flatMap((group) => [...group.views])).not.toContain("sessions");
  expect(Object.values(PAGES).map((page) => page.title)).not.toContain("Conversations");
  expect(parseRoute("/sessions")).toEqual({ view: "issues", id: null });
  expect(parseRoute("/sessions/unknown")).toEqual({
    view: "alias",
    kind: "sessions",
    id: "unknown",
  });
  expect(issueListRedirect("/sessions")).toBe("/issues");
  expect(issueListRedirect("/sessions/unknown-session")).toBeNull();
});

test("only work pages read the status snapshot; issue, Overview and Questions pages read their own resources", () => {
  const pages = Object.keys(PAGES).filter((view) => needsSnapshot({ view, id: null } as Route));
  expect(pages).toEqual(["evidence"]);
  expect(routeResource({ view: "mergeQueue" })).toBe("mergeQueue");
  expect(routeResource({ view: "issues", id: null })).toBe("issues");
  expect(routeResource({ view: "issues", id: "ENG-101" })).toBe("issue");
  expect(routeResource({ view: "runs", id: "r-1" })).toBe("issues");
  expect(routeResource({ view: "overview" })).toBe("overview");
  expect(routeResource({ view: "questions", id: null })).toBe("questions");
  expect(routeResource({ view: "questions", id: "Q-41" })).toBe("question");
  expect(routeResource({ view: "settings" })).toBeNull();
  expect(routeResource({ view: "alias", kind: "runs", id: "r-1" })).toBeNull();
});

test("every route names the status slices it renders", () => {
  expect(Object.keys(ROUTE_SLICES).sort()).toEqual(Object.keys(PAGES).sort());
  for (const slices of Object.values(ROUTE_SLICES))
    for (const slice of slices) expect(STATUS_SLICES).toContain(slice);
  expect(ROUTE_SLICES).toEqual({
    overview: [],
    issues: [],
    runs: [],
    alias: [],
    mergeQueue: [],
    questions: [],
    evidence: ["items", "evidence"],
    findings: [],
    runners: [],
    settings: [],
  });
});

test("a list loaded for one page does not stand in for another page's slices", () => {
  const evidence = { ...statusFixture(), slices: ["items", "evidence"] };
  const evidenceOnly = { ...statusFixture(), slices: ["evidence"] } as typeof evidence;
  expect(routeCovered({ view: "evidence", id: null }, evidence as never)).toBe(true);
  expect(routeCovered({ view: "evidence", id: null }, evidenceOnly as never)).toBe(false);
  expect(routeCovered({ view: "runners", id: null }, null)).toBe(true);
  expect(routeCovered({ view: "mergeQueue" }, statusFixture())).toBe(true);
  expect(routeCovered({ view: "evidence", id: null }, null)).toBe(false);
});
