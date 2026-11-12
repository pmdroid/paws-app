import {
  openedView,
  fullStatusFixture,
  issueResource,
  pageData,
  type FullStatus,
} from "../../test/fixtures";
import { describe, expect, test } from "bun:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseIssueDetailResponse, statusIntegrity } from "../contract";
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
  const parsed = parseIssueDetailResponse(
    JSON.parse(JSON.stringify(issueResource(snapshot, "ENG-101"))),
  );
  if (!parsed.ok) throw new Error(parsed.error);
  const detail = parsed.response;
  expect(statusIntegrity({ ...detail, items: [detail.issue, ...detail.earlierSessions] })).toEqual(
    [],
  );
  return snapshot;
}

function page(snapshot: FullStatus, id = "ENG-101"): string {
  return render({
    phase: "ready",
    error: null,
    engineUrl: null,
    closeout: openedView(),
    ...pageData(snapshot, { view: "issues", id }),
  }).content;
}

describe("issue page", () => {
  test("desktop: state, project, runner and agent, then the timeline and the pull request", () => {
    const html = page(redelegated());
    for (const term of ["project", "runner", "agent", "session", "repository"])
      expect(html).toContain(`<span class="min-w-0">${term} <span class="text-foreground">`);
    expect(html).toContain('id="activity-heading">Timeline</h2>');
    expect(html).toContain('id="merge-heading">Pull request and merge</h2>');
    expect(html).toContain('shared with <a class="lin-id" href="/issues/ENG-102">ENG-102</a>');
    expect(html.match(/<article /g)).toHaveLength(1);
  });

  test("390 px: facts and merge steps wrap instead of widening the page", () => {
    const html = renderToStaticMarkup(
      createElement(Fragment, null, themedMarkup(page(redelegated()))),
    );
    expect(html).toMatch(/class="issue-facts [^"]*flex-wrap/);
    expect(html).not.toMatch(/(?:^|[\s"])(?:min-)?w-\[\d/);
    expect(html).not.toMatch(/style="[^"]*width:\s*\d{3,}px/);
  });

  test("an issue with an earlier ended attempt renders only the current attempt", () => {
    const html = page(redelegated());
    expect(html.match(/<article /g)).toHaveLength(1);
    expect(html).toContain('href="https://linear.app/acme/issue/ENG-101#agent-session"');
    expect(html).not.toContain("earlier-attempt");
    expect(html).not.toContain("Earlier attempt");
    expect(html).not.toContain("Earlier session turn.");
    expect(html).not.toContain("r-101-earlier");
  });

  test("the item timeline lists every state change from the fake, the restart with its reason", () => {
    const parsed = parseIssueDetailResponse(
      JSON.parse(JSON.stringify(issueResource(fullStatusFixture(), "ENG-101"))),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const html = render({
      route: { view: "issues", id: "ENG-101" },
      phase: "ready",
      issue: parsed.response,
      error: null,
      engineUrl: null,
      closeout: openedView({ "section\ndetails:ENG-101": true }),
    }).content;
    const section = html.slice(html.indexOf('id="item-timeline-heading"'));
    expect(section).toContain(">State changes</h3>");
    const entries = section.slice(0, section.indexOf("</ol>")).match(/<li /g);
    expect(entries).toHaveLength(6);
    expect(section).toContain(
      'restart <span class="text-muted-foreground"><span aria-hidden="true">→</span><span class="sr-only">to</span> queued</span></p>',
    );
    expect(section).toContain("Back to the agent for Closeout findings.");
    expect(section).toContain(
      '<li data-kind="restart"><span class="timeline-dot" data-state="queued"',
    );
    expect(section).toContain(
      'closeout_accepted <span class="text-muted-foreground"><span aria-hidden="true">→</span><span class="sr-only">to</span> merge_queue</span>',
    );
    expect(html.indexOf('id="merge-heading"')).toBeLessThan(html.indexOf("item-timeline-heading"));
  });

  test("open run details lay out facts, a dotted state timeline and the run setup as panels", () => {
    const snapshot = fullStatusFixture();
    const item = snapshot.items.find((entry) => entry.id === "ENG-101")!;
    const run = snapshot.runs.find((entry) => entry.itemId === "ENG-101")!;
    const step = (at: string, from: string, to: string, event: string) => ({
      at,
      from,
      to,
      event,
      kind: "transition" as const,
      reason: null,
      actor: null,
    });
    item.timeline = [
      step("2026-10-09T20:58:00.000Z", "queued", "running", "dispatched"),
      ...[1, 2].flatMap((n) => [
        step(`2026-10-09T21:0${n}:00.000Z`, "running", "recovering", "runner_lost"),
        step(`2026-10-09T21:0${n}:30.000Z`, "recovering", "running", "recovered"),
      ]),
    ];
    item.linearRequests = 7;
    run.setup = {
      skills: [{ name: "impeccable", version: "2.4.1", installing: false }],
      hooks: [],
    };
    const closed = page(snapshot, "ENG-101");
    expect(closed).toContain('<section class="issue-fold" aria-label="Run details">');
    expect(closed).not.toContain('class="run-details"');
    const html = render({
      phase: "ready",
      error: null,
      engineUrl: null,
      closeout: openedView({ "section\ndetails:ENG-101": true }),
      ...pageData(snapshot, { view: "issues", id: "ENG-101" }),
    }).content;
    const body = html.slice(html.indexOf('<div class="run-details">'));
    expect(body.indexOf('<dl class="issue-facts-grid">')).toBe(25);
    expect(body.indexOf("item-timeline")).toBeLessThan(body.indexOf('class="run-setup"'));
    expect(body).toContain('<span class="timeline-dot" data-state="running" aria-hidden="true">');
    expect(body).toContain(
      '<li data-kind="loop"><span class="timeline-dot" data-state="recovering" aria-hidden="true">',
    );
    expect(body).toContain('<span class="tag">2 times</span>');
    expect(body).toContain(
      '<p class="timeline-meta mono muted text-muted-foreground"><time datetime="2026-10-09T21:01:00.000Z"',
    );
    expect(body).toMatch(/runner_lost .*recovering.* · recovered .*running/);
  });

  test("the header shows the state badge and project chip, and opens Linear and GitHub", () => {
    const snapshot = fullStatusFixture();
    const item = snapshot.items.find((entry) => entry.id === "ENG-101")!;
    item.project = { id: "p1", name: "Exports" };
    item.links = [
      { label: "Docs", href: "https://docs.example.com/exports" },
      { label: "Linear", href: "https://linear.app/acme/issue/ENG-101" },
    ];
    item.pr = { number: 479, url: "https://github.com/acme/platform/pull/479" };
    const html = page(snapshot);
    const header = html.slice(
      html.indexOf('<header class="issue-heading'),
      html.indexOf("</header>"),
    );
    expect(header).toContain(`<span class="st ${item.state}">${item.state}</span>`);
    expect(header).toContain('<span class="tag">project: Exports</span>');
    expect(header).toMatch(
      /<a class="btn" href="https:\/\/linear\.app\/acme\/issue\/ENG-101"[^>]*>Open in Linear <svg/,
    );
    expect(header).toMatch(
      /<a class="btn" href="https:\/\/github\.com\/acme\/platform\/pull\/479"[^>]*>Open GitHub <svg/,
    );
    expect(header).toContain(">Docs</a>");
    expect(html).toMatch(
      /id="merge-heading">Pull request and merge<\/h2><span class="lin-id">#479</,
    );

    item.links = [{ label: "Docs", href: "https://docs.example.com/exports" }];
    item.pr = null;
    const bare = page(snapshot);
    expect(bare).not.toContain("Open in Linear");
    expect(bare).not.toContain("Open GitHub");
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
    const parsed = parseIssueDetailResponse(
      JSON.parse(
        JSON.stringify({ ...issueResource(redelegated(), "ENG-101"), blocks: ["ENG-105"] }),
      ),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const html = render({
      route: { view: "issues", id: "ENG-101" },
      phase: "ready",
      issue: parsed.response,
      error: null,
      engineUrl: null,
      closeout: openedView(),
    }).content;
    expect(html).toContain('<article class="run-page issue-page">');
    expect(html).toContain('id="activity-heading">Timeline</h2>');
    expect(html).not.toContain("Earlier attempt");
    expect(html).toContain(
      'blocks <span class="text-foreground"><a href="/issues/ENG-105">ENG-105</a>',
    );
    expect(html).toContain('aria-label="Closeout"');
    const other = render({
      route: { view: "issues", id: "ENG-102" },
      phase: "ready",
      issue: parsed.response,
      error: null,
      engineUrl: null,
    }).content;
    expect(other).not.toContain("issue-page");
  });

  test("an item whose job failed on a full disk names the disk at the top of the page", () => {
    const snapshot = fullStatusFixture();
    const item = snapshot.items.find((entry) => entry.id === "ENG-101")!;
    item.hostDiskFull = "Paws's host is out of disk space (/tmp, 12 MB left)";
    const html = page(snapshot);
    expect(html).toContain("data-host-disk-full");
    expect(html).toContain("Paws&#39;s host is out of disk space (/tmp, 12 MB left)");
    expect(page(fullStatusFixture())).not.toContain("data-host-disk-full");
  });

  test("an internal path id reads as the issue identifier", () => {
    expect(plainTask("Task: PAS-367-01M5NDWPQZ0JQ91E1MFMVEY6EP")).toBe("Task: PAS-367");
    expect(plainTask("PAS-367 and PAS-3670")).toBe("PAS-367 and PAS-3670");
  });
});
