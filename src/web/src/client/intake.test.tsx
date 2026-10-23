import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseStatusSnapshot, type StatusIntakeEntry, type StatusSnapshot } from "../contract";
import { demoStatus } from "../demo";
import { render } from "./render";
import { themedMarkup } from "./theme";

const NOW = "2026-10-22T04:40:00.000Z";

function at(secondsAgo: number): string {
  return new Date(Date.parse(NOW) - secondsAgo * 1000).toISOString();
}

function waiting(
  issue: string,
  title: string | null,
  secondsAgo: number,
  patch: Partial<StatusIntakeEntry> = {},
): StatusIntakeEntry {
  return {
    issue,
    title,
    receivedAt: at(secondsAgo),
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    ...patch,
  };
}

function burst(): StatusSnapshot {
  const snapshot = demoStatus();
  snapshot.generatedAt = NOW;
  snapshot.intake = [
    waiting("ENG-301", "Export audit log as CSV", 240, {
      attempts: 2,
      nextAttemptAt: at(-30),
      lastError: "Linear GraphQL: RATELIMITED",
    }),
    waiting("ENG-302", "Paginate the audit log", 200, { nextAttemptAt: at(-45) }),
    waiting("ENG-303", null, 90, {
      attempts: 1,
      nextAttemptAt: at(-60),
      lastError: "a-very-long-error-message-without-spaces-".repeat(6),
    }),
  ];
  snapshot.linearBudget = {
    requestsRemaining: 0,
    requestsLimit: 1500,
    resetAt: "2026-10-22T04:55:00.000Z",
    holdUntil: "2026-10-22T04:55:00.000Z",
  };
  return snapshot;
}

function overview(snapshot: StatusSnapshot): string {
  return render({
    route: { view: "overview" },
    phase: "ready",
    snapshot,
    via: "engine",
    error: null,
    engineUrl: null,
  }).content;
}

function classNames(html: string, marker: string): string[] {
  return [...html.matchAll(/class="([^"]*)"/g)]
    .map((match) => match[1] ?? "")
    .filter((value) => value.split(/\s+/).includes(marker));
}

describe("intake queue and Linear budget on the overview", () => {
  test("desktop: one line for the queue, the hold, the budget and every waiting issue", () => {
    const html = overview(burst());
    expect(html).toContain('<h2 id="intake-heading">Intake</h2>');
    expect(html).toContain("Intake: 3 waiting, oldest 4 min, next in 15 min");
    expect(html).toContain("Linear rate limit: waiting until 04:55 UTC");
    expect(html).toContain("Linear budget: 0 of 1500 requests left this hour");
    expect(html.match(/class="overview-row intake-row"/g)).toHaveLength(3);
    expect(html.indexOf("ENG-301")).toBeLessThan(html.indexOf("ENG-302"));
    expect(html.indexOf("ENG-302")).toBeLessThan(html.indexOf("ENG-303"));
    expect(html).toContain("<b>Export audit log as CSV</b>");
    expect(html).toContain("Waiting 4 min · 2 failed attempts · retry in 30 s");
    expect(html).toContain("Last error: Linear GraphQL: RATELIMITED");
    expect(html).toContain("Waiting 90 s · 1 failed attempt · retry in 60 s");
  });

  test("without a hold the next intake is the earliest retry, or now when one is ready", () => {
    const snapshot = burst();
    snapshot.linearBudget = {
      requestsRemaining: 1180,
      requestsLimit: 1500,
      resetAt: null,
      holdUntil: null,
    };
    let html = overview(snapshot);
    expect(html).toContain("Intake: 3 waiting, oldest 4 min, next in 30 s");
    expect(html).toContain("Linear budget: 1180 of 1500 requests left this hour");
    expect(html).not.toContain("Linear rate limit");
    snapshot.intake![1]!.nextAttemptAt = null;
    html = overview(snapshot);
    expect(html).toContain("Intake: 3 waiting, oldest 4 min, next now");
  });

  test("an empty queue with a known budget still shows the budget", () => {
    const snapshot = demoStatus();
    snapshot.items = [];
    snapshot.questions = [];
    snapshot.intake = [];
    snapshot.linearBudget = {
      requestsRemaining: 1499,
      requestsLimit: 1500,
      resetAt: null,
      holdUntil: null,
    };
    const html = overview(snapshot);
    expect(html).toContain("Intake: nothing waiting");
    expect(html).toContain("Linear budget: 1499 of 1500 requests left this hour");
  });

  test("a waiting intake shows even before any issue exists", () => {
    const snapshot = burst();
    snapshot.items = [];
    snapshot.questions = [];
    expect(overview(snapshot)).toContain("Intake: 3 waiting");
  });

  test("a snapshot without intake data renders the overview as before", () => {
    expect(overview(demoStatus())).not.toContain("intake-heading");
  });

  test("390 px: rows wrap and long errors break instead of widening the page", () => {
    const html = renderToStaticMarkup(<>{themedMarkup(overview(burst()))}</>);
    for (const value of classNames(html, "intake-row")) {
      expect(value).toContain("flex-wrap");
      expect(value).toContain("min-w-0");
    }
    expect(classNames(html, "intake-row")).toHaveLength(3);
    for (const value of classNames(html, "overview-copy")) {
      expect(value).toContain("min-w-0");
      expect(value).toContain("break-words");
    }
    expect(classNames(html, "overview-section").length).toBeGreaterThan(0);
  });

  test("the status contract carries the queue and budget and rejects a bad timestamp", () => {
    const parsed = parseStatusSnapshot(JSON.parse(JSON.stringify(burst())));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.snapshot.intake).toEqual(burst().intake!);
    expect(parsed.snapshot.linearBudget).toEqual(burst().linearBudget!);
    const broken = JSON.parse(JSON.stringify(burst()));
    broken.intake[0].receivedAt = "soon";
    expect(parseStatusSnapshot(broken).ok).toBe(false);
    const budget = JSON.parse(JSON.stringify(burst()));
    budget.linearBudget.holdUntil = "later";
    expect(parseStatusSnapshot(budget).ok).toBe(false);
  });
});
