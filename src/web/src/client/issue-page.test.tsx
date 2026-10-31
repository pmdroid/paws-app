import {
  fullStatusFixture,
  itemDetail,
  pageData,
  statusList,
  type FullStatus,
} from "../../test/fixtures";
import { describe, expect, test } from "bun:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseStatusItemDetail, parseStatusSnapshot, statusIntegrity } from "../contract";
import { emptyCloseoutView } from "./closeout";
import { plainTask, render, timelineGroups } from "./render";
import { themedMarkup } from "./theme";

/** ENG-101 delegated twice: the current session shares a Linear session with ENG-102. */
function redelegated(): FullStatus {
  const snapshot = fullStatusFixture();
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
  const parsed = parseStatusSnapshot(JSON.parse(JSON.stringify(statusList(snapshot))));
  if (!parsed.ok) throw new Error(parsed.error);
  expect(statusIntegrity(parsed.snapshot)).toEqual([]);
  return snapshot;
}

function page(snapshot: FullStatus, id = "ENG-101"): string {
  return render({
    phase: "ready",
    error: null,
    engineUrl: null,
    closeout: emptyCloseoutView(),
    ...pageData(snapshot, { view: "issues", id }),
  }).content;
}

describe("issue page", () => {
  test("desktop: state, project, runner and agent, then the timeline, the pull request and earlier attempts", () => {
    const html = page(redelegated());
    for (const term of ["Project", "Runner", "Agent", "Session"])
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
    const parsed = parseStatusItemDetail(
      JSON.parse(JSON.stringify(itemDetail(fullStatusFixture(), "ENG-101"))),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const html = render({
      route: { view: "issues", id: "ENG-101" },
      phase: "ready",
      snapshot: null,
      detail: parsed.detail,
      error: null,
      engineUrl: null,
      closeout: { ...emptyCloseoutView(), open: { "section\ndetails:ENG-101": true } },
    }).content;
    const section = html.slice(html.indexOf('id="item-timeline-heading"'));
    expect(section).toContain(">State changes</h3>");
    const entries = section.slice(0, section.indexOf("</ol>")).match(/<li /g);
    expect(entries).toHaveLength(6);
    expect(section).toContain("<strong>queued</strong> Back to the agent for Closeout findings.");
    expect(section).toContain('<li data-kind="restart">');
    expect(section).toContain("<strong>merge queue</strong>");
    expect(section).toContain("from verifying · closeout_accepted");
    expect(html.indexOf('id="merge-heading"')).toBeLessThan(html.indexOf("item-timeline-heading"));
  });

  test("an item without recorded state changes has no item timeline", () => {
    expect(page(fullStatusFixture(), "ENG-102")).not.toContain("item-timeline");
  });

  test("state changes that bounce between two states fold into one line with a count", () => {
    const event = (at: string, from: string, to: string, name: string) => ({
      at,
      from,
      to,
      event: name,
      kind: "transition" as const,
      reason: null,
      actor: null,
    });
    const bounce = [1, 2, 3].flatMap((n) => [
      event(`2026-10-28T13:0${n}:00.000Z`, "running", "recovering", "lease_expired"),
      event(`2026-10-28T13:0${n}:30.000Z`, "recovering", "running", "recovered"),
    ]);
    const groups = timelineGroups([
      event("2026-10-28T12:52:00.000Z", "queued", "running", "dispatched"),
      ...bounce,
      event("2026-10-28T14:50:00.000Z", "running", "verifying", "turn_ended"),
    ]);
    expect(groups.map((group) => group.length)).toEqual([1, 6, 1]);
  });

  test("renders from the item detail alone, with no list snapshot", () => {
    const parsed = parseStatusItemDetail(
      JSON.parse(JSON.stringify({ ...itemDetail(redelegated(), "ENG-101"), blocks: ["ENG-105"] })),
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
      '<dt>Blocks</dt><dd><div class="row wrap"><a href="/issues/ENG-105">ENG-105</a>',
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
