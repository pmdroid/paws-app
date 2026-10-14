import { expect, test } from "bun:test";
import { NAVIGATION, PAGES } from "./navigation";
import { parseRoute, routeHref, type Route } from "./route";
import { render } from "./render";
import { demoStatus } from "../demo";

const model = {
  phase: "ready" as const,
  snapshot: demoStatus(),
  via: "bundled" as const,
  error: null,
  engineUrl: null,
  epicView: "graph" as const,
  selectedCheck: null,
};

test("sidebar exposes every page exactly once and all page links round-trip", () => {
  const views = NAVIGATION.flatMap((group) => [...group.views]);
  expect(new Set(views).size).toBe(Object.keys(PAGES).length);
  expect(views.length).toBe(Object.keys(PAGES).length);
  for (const view of views) {
    const route = { view, id: null } as Route;
    expect(parseRoute(routeHref(route)).view).toBe(view);
  }
});

test("empty pages retain their own heading and empty state", () => {
  const snapshot = {
    ...demoStatus(),
    items: [],
    epics: [],
    runs: [],
    questions: [],
    verdicts: [],
    mergeQueue: [],
  };
  for (const view of [
    "overview",
    "epics",
    "runs",
    "questions",
    "verdicts",
    "queue",
    "sessions",
  ] as const) {
    const html = render({
      ...model,
      snapshot,
      route: { view, id: null },
      conversations: { state: "ready", sessions: [] },
    }).content;
    expect(html.match(/<h1>/g)?.length).toBe(1);
    expect(html).toContain(`<h1>${PAGES[view].title}</h1>`);
    expect(html).toContain('class="empty"');
  }
});

test("invalid detail routes do not silently show a different result", () => {
  for (const view of ["epics", "runs", "verdicts"] as const) {
    const html = render({ ...model, route: { view, id: "missing" } }).content;
    expect(html).toContain("not found");
    expect(html).toContain("data-route-picker");
  }
});

test("epic view uses one tabs root with two labeled content panels", () => {
  const html = render({ ...model, route: { view: "epics", id: null } }).content;
  expect(html).toContain('data-view-tabs data-selected="graph"');
  expect(html).toContain('data-tab="graph" data-label="Dependencies"');
  expect(html).toContain('data-tab="board" data-label="Board"');
  expect(html).not.toContain('data-action="epic-view"');
});
