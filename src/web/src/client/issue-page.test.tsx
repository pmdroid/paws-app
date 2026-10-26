import { statusFixture } from "../../test/fixtures";
import { describe, expect, test } from "bun:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  parseStatusItemDetail,
  parseStatusSnapshot,
  statusIntegrity,
  type StatusSnapshot,
} from "../contract";
import { emptyCloseoutView } from "./closeout";
import { plainTask, render } from "./render";
import { themedMarkup } from "./theme";

/** ENG-101 delegated twice: the current session shares a Linear session with ENG-102. */
function redelegated(): StatusSnapshot {
  const snapshot = statusFixture();
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

  test("the item timeline lists every state change from the fake, the restart with its reason", () => {
    const snapshot = parseStatusSnapshot(JSON.parse(JSON.stringify(statusFixture())));
    if (!snapshot.ok) throw new Error(snapshot.error);
    const html = page(snapshot.snapshot);
    const section = html.slice(html.indexOf('id="item-timeline-heading"'));
    expect(section).toContain(">Item timeline</h2>");
    const entries = section.slice(0, section.indexOf("</ol>")).match(/<li /g);
    expect(entries).toHaveLength(6);
    expect(section).toContain("<strong>queued</strong> Back to the agent for Closeout findings.");
    expect(section).toContain('<li data-kind="restart">');
    expect(section).toContain("<strong>merge queue</strong>");
    expect(section).toContain("from verifying · closeout_accepted");
    expect(html.indexOf('id="merge-heading"')).toBeLessThan(html.indexOf("item-timeline-heading"));
  });

  test("an item without recorded state changes has no item timeline", () => {
    expect(page(statusFixture(), "ENG-102")).not.toContain("item-timeline");
  });

  test("renders from the item detail alone, with no list snapshot", () => {
    const full = redelegated();
    const mine = <T extends { itemId: string }>(rows: readonly T[] | undefined) =>
      (rows ?? []).filter((row) => row.itemId === "ENG-101");
    const parsed = parseStatusItemDetail(
      JSON.parse(
        JSON.stringify({
          ...full,
          id: "ENG-101",
          blocks: ["ENG-105"],
          items: full.items.filter((item) => item.id === "ENG-101"),
          runs: mine(full.runs),
          questions: mine(full.questions),
          verdicts: mine(full.verdicts),
          mergeQueue: mine(full.mergeQueue),
          events: [],
          evidence: mine(full.evidence),
          agentCloseout: mine(full.agentCloseout),
          ciRounds: mine(full.ciRounds),
        }),
      ),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const html = render({
      route: { view: "issues", id: "ENG-101" },
      phase: "ready",
      snapshot: null,
      detail: parsed.detail,
      error: null,
      engineUrl: null,
      closeout: emptyCloseoutView(),
    }).content;
    expect(html).toContain('<article class="run-page issue-page">');
    expect(html).toContain('id="activity-heading">Timeline</h2>');
    expect(html).toContain("Earlier attempt, ended ");
    expect(html).toContain(
      '<h2>Blocks</h2><div class="row wrap"><a href="/issues/ENG-105">ENG-105</a>',
    );
    expect(html).toContain('aria-label="Closeout"');
    const other = render({
      route: { view: "issues", id: "ENG-102" },
      phase: "ready",
      snapshot: null,
      detail: parsed.detail,
      error: null,
      engineUrl: null,
    }).content;
    expect(other).not.toContain("issue-page");
  });

  test("an internal path id reads as the issue identifier", () => {
    expect(plainTask("Task: PAS-367-01M5NDWPQZ0JQ91E1MFMVEY6EP")).toBe("Task: PAS-367");
    expect(plainTask("PAS-367 and PAS-3670")).toBe("PAS-367 and PAS-3670");
  });
});
