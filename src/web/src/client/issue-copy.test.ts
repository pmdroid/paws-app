import { statusFixture } from "../../test/fixtures";
import { describe, expect, test } from "bun:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StatusSnapshot } from "../contract";
import { NAVIGATION, PAGES } from "./navigation";
import { render } from "./render";
import { issueRedirect, parseRoute, type Route } from "./route";
import { themedMarkup } from "./theme";
import {
  runnerDetailMarkup,
  runnerHistoryMarkup,
  runnerRunningMarkup,
  runnerSkillsMarkup,
  runnerStrayMarkup,
  type Runner,
  type RunningSession,
  type Usage,
} from "./runners";

const RUN_WORD = /\bruns?\b/i;
const now = Date.parse("2026-10-24T12:00:00.000Z");

function visibleText(html: string): string {
  const labels = [...html.matchAll(/(?:aria-label|title|alt)="([^"]*)"/g)].map((match) => match[1]);
  return [html.replace(/<[^>]*>/g, " "), ...labels].join(" ").replace(/\s+/g, " ");
}

function taskHrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)]
    .map((match) => match[1]!)
    .filter((href) => /^\/(issues|runs|sessions|verdicts)\//.test(href));
}

function snapshotWithEvidence(): StatusSnapshot {
  const snapshot = statusFixture();
  const item = snapshot.items[0]!;
  const shot = {
    itemId: item.id,
    runId: snapshot.runs.find((run) => run.itemId === item.id)?.id ?? "r",
    checkId: "visual-proof",
    attempt: 1,
    mediaType: "image/png" as const,
    sizeBytes: 1,
    headCommit: "a".repeat(40),
    publishedAt: snapshot.generatedAt,
    publisher: "Claude",
  };
  snapshot.evidence = [
    { ...shot, id: "one", kind: "image", displayName: "one.png" },
    { ...shot, id: "two", kind: "image", displayName: "two.png" },
  ];
  return snapshot;
}

function page(route: Route, snapshot: StatusSnapshot = snapshotWithEvidence()): string {
  return render({
    route,
    phase: "ready",
    snapshot,
    error: null,
    engineUrl: null,
  }).content;
}

const PAGES_OUTSIDE_THE_ISSUE: [string, Route][] = [
  ["overview", { view: "overview" }],
  ["issues list", { view: "issues", id: null }],
  ["merge queue", { view: "mergeQueue" }],
  ["evidence", { view: "evidence", id: "one" }],
  ["questions", { view: "questions", id: null }],
];

describe("pages outside the issue page talk about issues", () => {
  for (const [name, route] of PAGES_OUTSIDE_THE_ISSUE)
    test(`${name} never says run`, () => {
      expect(visibleText(page(route))).not.toMatch(RUN_WORD);
    });

  for (const [name, route] of PAGES_OUTSIDE_THE_ISSUE)
    test(`${name} links each task to its issue page`, () => {
      for (const href of taskHrefs(page(route))) expect(href).toMatch(/^\/issues\/[^/]+/);
    });

  test("the old runs list opens the issues list and run links still open their issue", () => {
    const snapshot = statusFixture();
    const run = snapshot.runs[0]!;
    expect(parseRoute("/runs")).toEqual({ view: "issues", id: null });
    expect(issueRedirect(`/runs/${run.id}`, snapshot)).toBe(`/issues/${run.itemId}`);
    expect(page({ view: "runs", id: "missing" }, snapshot)).toContain("Issue not found");
  });

  test("the issues list says why a queued issue waits, and wraps at 390 px", () => {
    const snapshot = statusFixture();
    for (const item of snapshot.items) {
      if (item.id === "ENG-100") Object.assign(item, { state: "queued", blockers: ["ENG-102"] });
      if (item.id === "ENG-103")
        Object.assign(item, {
          state: "queued",
          queue: { position: 1, busySlots: 4, totalSlots: 4 },
        });
    }
    const html = page({ view: "issues", id: null }, snapshot);
    const reason = (id: string) =>
      new RegExp(`data-issue-id="${id}".*?data-wait-reason>([^<]+)<`).exec(html)?.[1];
    expect(reason("ENG-100")).toBe("Blocked by ENG-102");
    expect(reason("ENG-103")).toBe("Waiting for a free runner");
    const themed = renderToStaticMarkup(createElement(Fragment, null, themedMarkup(html)));
    expect(themed).toMatch(
      /class="[^"]*flex-wrap[^"]*"[^>]*><span[^>]*>[^<]*<\/span><span[^>]*data-wait-reason/,
    );
    expect(themed).not.toMatch(/(?:^|[\s"])(?:min-)?w-\[\d/);
  });

  test("navigation names issues, not runs", () => {
    const views: readonly string[] = NAVIGATION.flatMap((group) => group.views);
    expect(views).not.toContain("runs");
    for (const view of views) {
      const entry = PAGES[view as keyof typeof PAGES];
      expect(`${entry.title} ${entry.description}`).not.toMatch(RUN_WORD);
    }
  });

  test("the overview calls a paused task a paused issue", () => {
    const snapshot = statusFixture();
    const run = snapshot.runs[0]!;
    const item = snapshot.items.find((entry) => entry.id === run.itemId)!;
    item.state = "running";
    item.runId = run.id;
    run.state = "paused";
    snapshot.questions = [];
    const html = page({ view: "overview" }, snapshot);
    expect(html).toContain("This issue is paused.");
    expect(visibleText(html)).not.toMatch(RUN_WORD);
  });
});

describe("the runner card lists running issues", () => {
  const working: RunningSession = {
    runId: "run-1",
    identifier: "PAS-367",
    title: "Parse <config> files",
    phase: "working",
    startedAt: now - 12 * 60_000,
  };
  const runner: Runner = {
    id: "01JRUNNER0000000000000000A",
    name: "build-box",
    ownerUserId: "owner-1",
    status: "active",
    metrics: {
      cpuPercent: 10,
      memoryTotalBytes: null,
      memoryAvailableBytes: null,
      load1: null,
      load5: null,
      load15: null,
      diskTotalBytes: null,
      diskFreeBytes: null,
      strayProcesses: [{ pid: 42, name: "node", ageSeconds: 600, cpuPercent: 5 }],
      reportedAt: now,
    },
    os: null,
    version: "1.2.0",
    idle: false,
    slots: { used: 1, total: 3 },
    running: [working],
    skills: [
      {
        name: "closeout",
        version: "2.0.0",
        installedVersion: "1.0.0",
        state: "installing",
        error: null,
        reportedAt: now,
      },
    ],
  };
  const view = {
    now,
    serverVersion: "1.2.0",
    policy: null,
    userId: null,
    role: "member",
    busy: false,
  };

  test("each running issue links its identifier and title to the issue page", () => {
    const html = runnerRunningMarkup([working], now, { used: 1, total: 3 });
    expect(html).toContain(
      '<a class="work-title" href="/issues/PAS-367"><span class="lin-id">PAS-367</span> Parse &lt;config&gt; files</a>',
    );
    expect(html).toContain('<span class="st running">Working</span>');
    expect(html).toContain(">12m</span>");
  });

  test("the card heads the list Running issues and counts slots in use", () => {
    const html = runnerDetailMarkup(runner, view);
    expect(html).toContain(">Running issues</h3>");
    expect(html).toContain(">1 of 3 slots in use</span>");
    expect(taskHrefs(html)).toEqual(["/issues/PAS-367"]);
    expect(visibleText(html)).not.toMatch(RUN_WORD);
  });

  test("the history lists the issue each execution worked on", () => {
    const entry: Usage = {
      commandId: "command-1",
      runnerId: runner.id,
      runnerName: runner.name,
      runId: "run-7",
      identifier: "PAS-367",
      title: "Parse config files",
      agent: "claude",
      resolvedModel: "claude-opus",
      purpose: "work",
      outcome: "success",
      startedAt: now - 125_000,
      endedAt: now,
    };
    const html = runnerHistoryMarkup([
      entry,
      { ...entry, commandId: "command-2", runId: null, identifier: null, title: null },
    ]);
    expect(html).toContain("<th>Issue</th>");
    expect(html).toContain(
      '<a class="work-title" href="/issues/PAS-367"><span class="lin-id">PAS-367</span> Parse config files</a>',
    );
    expect(taskHrefs(html)).toEqual(["/issues/PAS-367"]);
    expect(visibleText(html)).not.toMatch(RUN_WORD);
  });

  test("skills and stray processes never say run", () => {
    expect(visibleText(runnerSkillsMarkup(runner.skills!, runner.name))).not.toMatch(RUN_WORD);
    expect(visibleText(runnerStrayMarkup(runner.metrics!.strayProcesses!))).not.toMatch(RUN_WORD);
  });
});
