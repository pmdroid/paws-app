import { describe, expect, test } from "bun:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseStatusSnapshot, statusIntegrity, type StatusSnapshot } from "../contract";
import { demoStatus } from "../demo";
import { emptyCloseoutView } from "./closeout";
import { plainTask, render } from "./render";
import { themedMarkup } from "./theme";

/** ENG-101 delegated twice: the current session shares a Linear session with ENG-102. */
function redelegated(): StatusSnapshot {
  const snapshot = demoStatus();
  const item = snapshot.items.find((entry) => entry.id === "ENG-101")!;
  const run = snapshot.runs.find((entry) => entry.itemId === "ENG-101")!;
  item.session = {
    id: "6f1c2f4e-2a51-4c1e-9d8e-3c5b1f0a7e21",
    url: "https://linear.app/acme/issue/ENG-101#agent-session",
    shared: ["ENG-102"],
  };
  snapshot.items.push({
    ...item,
    state: "completed",
    runId: "r-101-earlier",
    pr: null,
    links: [],
    endedAt: "2026-10-09T20:40:00.000Z",
    session: { id: "earlier", url: "https://linear.app/acme/issue/ENG-101", shared: [] },
  });
  snapshot.runs.push({
    ...run,
    id: "r-101-earlier",
    attempts: ["r-101-earlier"],
    state: "done",
    startedAt: "2026-10-09T19:00:00.000Z",
    activity: [{ at: "2026-10-09T19:05:00.000Z", kind: "thought", text: "Earlier session turn." }],
  });
  const parsed = parseStatusSnapshot(JSON.parse(JSON.stringify(snapshot)));
  if (!parsed.ok) throw new Error(parsed.error);
  expect(statusIntegrity(parsed.snapshot)).toEqual([]);
  return parsed.snapshot;
}

function page(snapshot: StatusSnapshot, id = "ENG-101"): string {
  return render({
    route: { view: "issues", id },
    phase: "ready",
    snapshot,
    via: "bundled",
    error: null,
    engineUrl: null,
    closeout: emptyCloseoutView(),
  }).content;
}

describe("issue page", () => {
  test("desktop: state, project, runner and agent, then the timeline, the pull request and earlier attempts", () => {
    const html = page(redelegated());
    for (const term of ["State", "Project", "Runner", "Agent", "Session"])
      expect(html).toContain(`<dt>${term}</dt>`);
    const order = [
      'id="activity-heading">Timeline</h2>',
      'id="merge-heading">Pull request and merge</h2>',
      'class="earlier-attempt"',
    ].map((marker) => html.indexOf(marker));
    expect(order.every((at) => at > 0)).toBe(true);
    expect(order[0]).toBeLessThan(order[2]!);
    expect(html).toContain("Earlier attempt, ended ");
    expect(html).toContain("Earlier session turn.");
    expect(html).toContain('shared with <a class="lin-id" href="/issues/ENG-102">ENG-102</a>');
    expect(html.match(/<article /g)).toHaveLength(1);
  });

  test("390 px: facts, merge steps and earlier attempts wrap instead of widening the page", () => {
    const html = renderToStaticMarkup(
      createElement(Fragment, null, themedMarkup(page(redelegated()))),
    );
    expect(html).toContain("issue-facts-grid");
    expect(html).toContain("earlier-attempt");
    expect(html).not.toMatch(/(?:^|[\s"])(?:min-)?w-\[\d/);
    expect(html).not.toMatch(/style="[^"]*width:\s*\d{3,}px/);
  });

  test("an internal path id reads as the issue identifier", () => {
    expect(plainTask("Task: PAS-367-01M5NDWPQZ0JQ91E1MFMVEY6EP")).toBe("Task: PAS-367");
    expect(plainTask("PAS-367 and PAS-3670")).toBe("PAS-367 and PAS-3670");
  });
});
