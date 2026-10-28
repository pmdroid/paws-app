import { fullStatusFixture, pageData, type FullStatus } from "../../test/fixtures";
import { describe, expect, test } from "bun:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StatusStateTimes } from "../contract";
import { emptyCloseoutView } from "./closeout";
import { render } from "./render";
import type { Route } from "./route";
import { hoursLabel, itemAgeLine } from "./state-times";
import { themedMarkup } from "./theme";

const MIN = 60_000;
const SINCE = "2026-10-09T19:00:00.000Z";

function times(states: Record<string, number>, current: string | null): StatusStateTimes {
  const total = Object.values(states).reduce((sum, minutes) => sum + minutes, 0);
  return {
    since: SINCE,
    until: new Date(Date.parse(SINCE) + total * MIN).toISOString(),
    current,
    states: Object.entries(states).map(([state, minutes]) => ({ state, ms: minutes * MIN })),
  };
}

function view(snapshot: FullStatus, route: Route): string {
  return render({
    phase: "ready",
    error: null,
    engineUrl: null,
    closeout: emptyCloseoutView(),
    ...pageData(snapshot, route),
  }).content;
}

describe("time in each state", () => {
  test("the issue page bar has a segment for each state, labelled with its minutes", () => {
    const snapshot = fullStatusFixture();
    const item = snapshot.items.find((entry) => entry.id === "ENG-101")!;
    item.stateTimes = times(
      { queued: 89, running: 182, recovering: 187, awaiting_input: 48, merge_queue: 73 },
      "merge_queue",
    );
    const html = view(snapshot, { view: "issues", id: "ENG-101" });
    const section = html.slice(
      html.indexOf('class="state-times"'),
      html.indexOf("</section>", html.indexOf('class="state-times"')),
    );

    expect(section).toContain("Time in each state");
    expect(section).toContain("9 h 39 min since delegation");
    const segments = [
      ...section.matchAll(
        /class="time-seg" data-state="([a-z_]+)" data-ms="(\d+)"[^>]*><span class="time-seg-label">([^<]+)</g,
      ),
    ].map(([, state, ms, label]) => [state, Number(ms) / MIN, label]);
    // In the order of the flow, not the order the provider listed them.
    expect(segments).toEqual([
      ["queued", 89, "89 min"],
      ["running", 182, "182 min"],
      ["recovering", 187, "187 min"],
      ["awaiting_input", 48, "48 min"],
      ["merge_queue", 73, "73 min"],
    ]);
    expect(section).toContain('data-state="merge_queue" data-ms="4380000" data-current');
    expect(section).toContain("awaiting input <b>48 min</b>");
    expect(section).toContain('merge queue <b>73 min</b> <span class="muted">now</span>');
    // Before the Closeout result and the timeline of the run.
    expect(html.indexOf("state-times-heading")).toBeLessThan(html.indexOf("activity-heading"));
  });

  test("each segment grows with its time once themed", () => {
    const snapshot = fullStatusFixture();
    snapshot.items.find((entry) => entry.id === "ENG-101")!.stateTimes = times(
      { queued: 10, running: 30 },
      "running",
    );
    const themed = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        themedMarkup(view(snapshot, { view: "issues", id: "ENG-101" })),
      ),
    );
    expect(themed).toContain('style="flex-grow:600000"');
    expect(themed).toContain('style="flex-grow:1800000"');
  });

  test("an item without state times has no bar", () => {
    expect(view(fullStatusFixture(), { view: "issues", id: "ENG-101" })).not.toContain(
      "state-times",
    );
  });

  test("the overview shows each open item's age and its biggest waiting state", () => {
    const snapshot = fullStatusFixture();
    const working = snapshot.items.find(
      (entry) => entry.state === "running" && !entry.blockers.length,
    )!;
    working.stateTimes = times({ queued: 20, running: 50, recovering: 120 }, "running");
    const asking = snapshot.items.find((entry) => entry.state === "awaiting_input")!;
    asking.stateTimes = times({ queued: 5, running: 30, awaiting_input: 45 }, "awaiting_input");
    const html = view(snapshot, { view: "overview" });

    expect(html).toContain("3 h 10 min · 2 h recovering");
    expect(html).toContain("1 h 20 min · 45 min awaiting input");
  });

  test("the biggest waiting state skips running and verifying, and a finished item has no age", () => {
    const snapshot = fullStatusFixture();
    const item = snapshot.items[0]!;
    item.stateTimes = times({ running: 300, verifying: 60, queued: 2 }, "verifying");
    expect(itemAgeLine(item)).toBe("6 h 2 min · 2 min queued");
    item.stateTimes = times({ running: 30 }, "running");
    expect(itemAgeLine(item)).toBe("30 min");
    item.stateTimes = times({ running: 30, merge_queue: 10 }, null);
    expect(itemAgeLine(item)).toBeNull();
    expect(hoursLabel(2 * 60 * MIN)).toBe("2 h");
  });

  test("the issues list shows the age too", () => {
    const snapshot = fullStatusFixture();
    snapshot.items.find((entry) => entry.id === "ENG-101")!.stateTimes = times(
      { queued: 111, running: 60, merge_queue: 24 },
      "merge_queue",
    );
    const html = view(snapshot, { view: "issues", id: null });
    expect(html).toContain("3 h 15 min · 1 h 51 min queued");
  });

  test("the last 24 hours: merged count, median, p90 and the average per state", () => {
    const snapshot = fullStatusFixture();
    snapshot.mergedTimes = {
      since: "2026-10-08T22:15:00.000Z",
      merged: 19,
      medianMs: 602 * MIN,
      p90Ms: 840 * MIN,
      states: [
        { state: "recovering", ms: 187 * MIN },
        { state: "running", ms: 182 * MIN },
        { state: "queued", ms: 89 * MIN },
      ],
    };
    const html = view(snapshot, { view: "overview" });
    const section = html.slice(html.indexOf("merged-times-heading"));
    expect(section).toContain("Last 24 hours");
    expect(section).toContain("19 merged · median 10 h 2 min · p90 14 h from start to merge");
    const rows = [
      ...section.matchAll(/<tr data-state="([a-z_]+)">.*?<\/i>([^<]+)<\/td><td>([^<]+)</g),
    ].map(([, , name, minutes]) => [name, minutes]);
    expect(rows).toEqual([
      ["recovering", "187 min"],
      ["running", "182 min"],
      ["queued", "89 min"],
    ]);
  });

  test("no 24-hour section while nothing merged", () => {
    expect(view(fullStatusFixture(), { view: "overview" })).not.toContain("Last 24 hours");
  });
});
