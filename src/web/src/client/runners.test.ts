import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { themedMarkup } from "./theme";
import {
  compareVersions,
  livePoll,
  RUNNER_POLL_MS,
  runnerActionsMarkup,
  runnerDetailMarkup,
  runnerHistoryMarkup,
  runnerRowMarkup,
  runnerRunningMarkup,
  type Runner,
  type RunningSession,
  type Usage,
} from "./runners";
import { parseRoute, routeHref } from "./route";

const now = 1_000_000_000;
const runner: Runner = {
  id: "01JRUNNER0000000000000000A",
  name: "build-box",
  ownerUserId: "owner",
  status: "active",
  metrics: {
    cpuPercent: 42.4,
    memoryTotalBytes: 16 * 1024 ** 3,
    memoryAvailableBytes: 4 * 1024 ** 3,
    load1: 0.5,
    load5: 0.25,
    load15: 0.125,
    diskTotalBytes: 100 * 1024 ** 3,
    diskFreeBytes: 40 * 1024 ** 3,
    reportedAt: now - 5_000,
  },
  os: { id: "ubuntu", version: "24.04" },
  version: "1.2.0",
  idle: true,
  agents: [
    { agent: "claude", status: "signed_in", checkedAt: now - 1_000 },
    { agent: "codex", status: "unknown", checkedAt: null },
  ],
};
const view = {
  now,
  serverVersion: "1.2.0",
  policy: {
    ownerUserId: "owner",
    sharing: 1,
  },
  userId: "owner",
  role: "owner",
  busy: false,
};

describe("runner list rows", () => {
  const row = { now, serverVersion: "1.2.0" };

  test("a row links to the runner and summarizes its state", () => {
    const html = runnerRowMarkup(runner, row);
    expect(html).toContain('href="/runners/01JRUNNER0000000000000000A"');
    expect(html).toContain("<b>build-box</b>");
    expect(html).toContain('<span class="tag ok">Idle</span>');
    expect(html).toContain("Seen just now · ubuntu 24.04 · Runner 1.2.0 · Claude signed in");
    expect(html).not.toContain("Update available");
    expect(html).not.toContain("data-runner-seat");
    expect(html).not.toContain("<dl");
  });

  test("a row flags offline hosts, paused status, signed-out agents and old versions", () => {
    const html = runnerRowMarkup(
      {
        ...runner,
        status: "paused",
        version: "1.1.0",
        metrics: { ...runner.metrics!, reportedAt: now - 5 * 60_000 },
        agents: [{ agent: "codex", status: "signed_out", checkedAt: now }],
      },
      row,
    );
    expect(html).toContain('<span class="tag bad">Offline</span>');
    expect(html).toContain('<span class="tag paused">Paused</span>');
    expect(html).toContain('<span class="tag bad">Codex signed out</span>');
    expect(html).toContain("Update available");
    expect(html).toContain("No agent signed in");
  });

  test("a revoked runner without reports says so", () => {
    const html = runnerRowMarkup({ ...runner, status: "revoked", metrics: null }, row);
    expect(html).toContain('<span class="tag bad">Revoked</span>');
    expect(html).toContain("Never reported");
    expect(html).not.toContain("signed in");
  });
});

describe("runner execution history", () => {
  const entry: Usage = {
    commandId: "command-1",
    runnerId: runner.id,
    runnerName: runner.name,
    runId: "run-7",
    agent: "claude",
    resolvedModel: "claude-opus",
    purpose: "work",
    outcome: "success",
    startedAt: now - 125_000,
    endedAt: now,
  };

  test("lists each execution with its run, agent, duration and outcome", () => {
    const html = runnerHistoryMarkup([
      entry,
      {
        ...entry,
        commandId: "command-2",
        runId: null,
        agent: null,
        resolvedModel: null,
        purpose: "check",
        outcome: null,
        endedAt: null,
      },
    ]);
    expect(html).toContain('<a href="/runs/run-7">Work</a>');
    expect(html).toContain("claude-opus");
    expect(html).toContain("2m 5s");
    expect(html).toContain('<span class="tag ok">Success</span>');
    expect(html).toContain("<td>Checks</td><td>None</td>");
    expect(html).toContain('<span class="tag running">Running</span>');
  });

  test("an unused runner has an empty history", () => {
    expect(runnerHistoryMarkup([])).toContain("has not executed any work yet");
  });
});

describe("what a runner is running now", () => {
  const working: RunningSession = {
    runId: "run-1",
    identifier: "ENG-7",
    title: "Parse <config> files",
    phase: "working",
    startedAt: now - 12 * 60_000,
  };
  const closeout: RunningSession = {
    runId: "run-2",
    identifier: "ENG-9",
    title: "Cache the token",
    phase: "closeout",
    startedAt: now - 75 * 60_000,
  };
  const row = { now, serverVersion: "1.2.0" };

  test("an idle runner shows nothing running", () => {
    expect(runnerRunningMarkup([], now)).toBe('<p class="muted">Nothing running</p>');
    expect(runnerRowMarkup({ ...runner, running: [] }, row)).toContain(
      '<span class="tag ok">Idle</span>',
    );
    expect(runnerDetailMarkup({ ...runner, running: [] }, view)).toContain(
      "Active · Online · Idle",
    );
  });

  test("a runner with one session links its issue to the run page", () => {
    const html = runnerRunningMarkup([working], now);
    expect(html).toContain('aria-label="Running sessions"');
    expect(html).toContain('href="/runs/run-1"');
    expect(html).toContain('<span class="lin-id">ENG-7</span> <b>Parse &lt;config&gt; files</b>');
    expect(html).toContain('<span class="st running">Working</span>');
    expect(html).toContain("Running for 12m");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
    const busy = { ...runner, idle: false, running: [working] };
    expect(runnerRowMarkup(busy, row)).toContain('<span class="tag running">Running 1</span>');
    expect(runnerDetailMarkup(busy, view)).toContain("Active · Online · Running 1");
    expect(runnerDetailMarkup(busy, view)).not.toContain("Busy");
  });

  test("a runner with two sessions lists both with their phases", () => {
    const html = runnerRunningMarkup([working, closeout], now);
    expect(html.match(/<li /g)).toHaveLength(2);
    expect(html.indexOf("ENG-7")).toBeLessThan(html.indexOf("ENG-9"));
    expect(html).toContain('href="/runs/run-2"');
    expect(html).toContain('<span class="st verifying">Closeout</span>');
    expect(html).toContain("Running for 1h 15m");
    expect(
      runnerRowMarkup({ ...runner, idle: false, running: [working, closeout] }, row),
    ).toContain('<span class="tag running">Running 2</span>');
  });

  test("each phase has its label", () => {
    const labels = (["working", "closeout", "fixing", "merging"] as const).map((phase) =>
      runnerRunningMarkup([{ ...working, phase, startedAt: now - 1_000 }], now),
    );
    expect(labels.map((html) => />(Working|Closeout|Fixing|Merging)</.exec(html)?.[1])).toEqual([
      "Working",
      "Closeout",
      "Fixing",
      "Merging",
    ]);
    expect(labels[0]).toContain("Running for under a minute");
  });
});

test("runner routes carry the selected runner", () => {
  expect(parseRoute("/runners")).toEqual({ view: "runners", id: null });
  expect(parseRoute("/runners/runner-1")).toEqual({ view: "runners", id: "runner-1" });
  expect(routeHref({ view: "runners", id: "runner-1" })).toBe("/runners/runner-1");
  expect(routeHref({ view: "runners", id: null })).toBe("/runners");
});

describe("runner details", () => {
  test("an idle runner shows its host metrics, sign-in, sharing and controls", () => {
    const html = runnerDetailMarkup(runner, view);
    expect(html).toContain("build-box");
    expect(html).toContain("Active");
    expect(html).toContain("Online");
    expect(html).toContain("Idle");
    expect(html).not.toContain("Busy");
    expect(html).toContain("1.2.0");
    expect(html).not.toContain("Update available");
    expect(html).toContain("Seen just now");
    expect(html).toContain("Updated 5 s ago");
    expect(html).toContain('data-fresh="live"');
    expect(html).toContain("ubuntu 24.04");
    expect(html).toContain("42%");
    expect(html).toContain('data-metric="cpu" data-level="ok"');
    expect(html).toContain('data-fill="42"');
    expect(html).toContain("12 GB used of 16 GB");
    expect(html).toContain('data-metric="memory"');
    expect(html).toContain('data-fill="75"');
    expect(html).toContain('data-metric="load"');
    expect(html).toContain(">0.50<");
    expect(html).not.toContain("0.50 / 0.25 / 0.13");
    expect(html).toContain("60 GB used of 100 GB");
    expect(html).toContain('data-runner-copy="');
    expect(html).toContain(">Copy id<");
    expect(html).not.toContain("<code>");
    expect(html.match(/data-runner-state/g)).toHaveLength(1);
    expect(html.match(/data-runner-status="/g)).toHaveLength(3);
    expect(runnerDetailMarkup({ ...runner, slots: { used: 2, total: 10 } }, view)).toContain(
      'data-metric="slots"',
    );
    expect(runnerDetailMarkup({ ...runner, slots: { used: 2, total: 10 } }, view)).toContain(
      "2 of 10 in use",
    );
    expect(
      runnerRowMarkup({ ...runner, slots: { used: 2, total: 10 } }, { now, serverVersion: null }),
    ).toContain("2 of 10 slots in use");
    expect(html).toContain('<span class="tag ok">Signed in</span>');
    expect(html).toContain('<span class="tag ">Not checked</span>');
    expect(html).not.toContain("account type");
    expect(html).toMatch(/data-runner-sharing="[^"]+"[^>]* checked/);
    expect(html).toContain(">Pause<");
    expect(html).toContain(">Drain<");
    expect(html).toContain("Revoke access");
    expect(html).not.toContain(" disabled");
    expect(html).not.toContain("View health");
    expect(html).not.toContain("Check sign-in");
    expect(html).not.toContain("Check connection");
  });

  test("a busy runner says so", () => {
    const html = runnerDetailMarkup({ ...runner, idle: false }, view);
    expect(html).toContain("Active · Online · Busy");
    expect(html).not.toContain(">Idle<");
  });

  test("an offline runner says when it was last seen and hides idle or busy", () => {
    const html = runnerDetailMarkup(
      { ...runner, idle: false, metrics: { ...runner.metrics!, reportedAt: now - 5 * 60_000 } },
      view,
    );
    expect(html).toContain("Active · Offline");
    expect(html).toContain("5m ago");
    expect(html).toContain('data-fresh="stale"');
    expect(html).toContain("Stale · Updated 5 m ago");
    expect(html).not.toContain("Busy");
    expect(html).not.toContain("Idle");
  });

  test("a runner that never reported is offline", () => {
    const html = runnerDetailMarkup({ ...runner, metrics: null, os: null, version: null }, view);
    expect(html).toContain("Offline");
    expect(html).toContain("Never seen");
    expect(html).toContain('data-metric="cpu"');
    expect(html).toContain("Not reported");
    expect(html).not.toContain("data-fill");
    expect(html).not.toContain("Updated");
  });

  test("a signed-out agent and an older runner version are flagged", () => {
    const html = runnerDetailMarkup(
      {
        ...runner,
        version: "1.1.9",
        agents: [{ agent: "claude", status: "signed_out", checkedAt: now }],
      },
      view,
    );
    expect(html).toContain('<span class="tag bad">Signed out</span>');
    expect(html).toContain("Update available");
  });

  test("members who do not own the host see disabled sharing settings", () => {
    const html = runnerDetailMarkup(runner, { ...view, userId: "someone", role: "member" });
    expect(html).toMatch(/data-runner-sharing="[^"]+"[^>]* disabled/);
    expect(html).toContain("The host owner controls its sharing settings.");
    expect(html).not.toContain(">Pause<");
  });

  test("a revoked runner has no settings or controls", () => {
    const html = runnerDetailMarkup({ ...runner, status: "revoked" }, view);
    expect(html).toContain("Revoked");
    expect(html).toContain("Offline");
    expect(html).not.toContain("data-runner-sharing");
    expect(html).not.toContain("data-runner-status");
    expect(html).not.toContain("data-runner-signin");
  });

  test("members sign in to the agents from the runner card, observers cannot", () => {
    expect(runnerDetailMarkup(runner, { ...view, userId: "member", role: "member" })).toContain(
      `data-runner-signin="${runner.id}"`,
    );
    expect(
      runnerDetailMarkup(runner, { ...view, userId: "guest", role: "observer" }),
    ).not.toContain("data-runner-signin");
  });

  describe("concurrency", () => {
    const tuned: Runner = {
      ...runner,
      slots: { used: 1, total: 2 },
      concurrency: { desired: 2, applied: 2, ceiling: 4 },
    };

    test("owners and admins edit it next to the slots, up to the host limit", () => {
      for (const role of ["owner", "admin"]) {
        const html = runnerDetailMarkup(tuned, { ...view, role });
        expect(html).toContain('data-metric="slots"');
        expect(html).toContain("1 of 2 in use");
        expect(html.indexOf('data-metric="slots"')).toBeLessThan(html.indexOf(">Concurrency<"));
        expect(html).toContain(`data-runner-concurrency="${runner.id}"`);
        expect(html).toContain('aria-label="Concurrency, from 1 to 4" value="2"');
        expect(html).toContain("Host limit 4. Runner applied 2.");
      }
      expect(runnerDetailMarkup(tuned, { ...view, busy: true })).toMatch(
        /name="concurrency"[^>]* disabled/,
      );
      expect(runnerDetailMarkup(tuned, { ...view, concurrencyDraft: "3" })).toContain('value="3"');
    });

    test("members and observers see the value without a field", () => {
      for (const role of ["member", "observer"]) {
        const html = runnerDetailMarkup(tuned, { ...view, userId: role, role });
        expect(html).toContain('2 <span class="muted">Host limit 4. Runner applied 2.</span>');
        expect(html).not.toContain("data-runner-concurrency");
      }
    });

    test("a runner without a reported ceiling keeps its config value", () => {
      const html = runnerDetailMarkup(
        { ...tuned, concurrency: { desired: null, applied: 2, ceiling: null } },
        view,
      );
      expect(html).toContain("Update the runner to change it here.");
      expect(html).not.toContain("data-runner-concurrency");
      expect(runnerDetailMarkup({ ...tuned, status: "revoked" }, view)).not.toContain(
        "Concurrency",
      );
    });
  });
});

function painted(html: string): string {
  return renderToStaticMarkup(createElement(Fragment, null, themedMarkup(html)));
}

function metricSlice(html: string, metric: string): string {
  const start = html.indexOf(`data-metric="${metric}"`);
  if (start < 0) throw new Error(`missing ${metric}`);
  const next = html.indexOf('data-metric="', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

function slotRow(html: string): string {
  const row = /<div class="slot-row[\s\S]*?<\/div>/.exec(html)?.[0];
  if (!row) throw new Error("missing slot row");
  return row;
}

describe("host metric visuals", () => {
  test("normal values stay quiet and high values warn", () => {
    const calm = runnerDetailMarkup(
      {
        ...runner,
        slots: { used: 1, total: 3 },
        metrics: {
          ...runner.metrics!,
          cpuPercent: 90,
          memoryTotalBytes: 100,
          memoryAvailableBytes: 10,
          diskTotalBytes: 100,
          diskFreeBytes: 10,
          load1: 8,
          cpuCount: 8,
        },
      },
      view,
    );
    expect(calm).toContain('data-metric="cpu" data-level="ok"');
    expect(calm).toContain('data-metric="memory" data-level="ok"');
    expect(calm).toContain('data-metric="disk" data-level="ok"');
    expect(calm).toContain('data-metric="load" data-level="ok"');
    expect(calm.match(/data-fill="90"/g)).toHaveLength(3);
    expect(calm).toContain('data-fill="100"');
    expect(calm).toContain("8.00 of 8");
    expect(calm).toContain('data-metric="slots" data-level="ok"');
    expect(calm.match(/data-used="true"/g)).toHaveLength(1);
    expect(calm.match(/data-used="false"/g)).toHaveLength(2);
    const calmPaint = painted(calm);
    expect(metricSlice(calmPaint, "cpu")).toMatch(/width:\s*90%/);
    expect(metricSlice(calmPaint, "cpu")).toMatch(/bg-foreground(?!\/)/);
    expect(metricSlice(calmPaint, "cpu")).not.toContain("bg-main");
    expect(metricSlice(calmPaint, "memory")).toMatch(/width:\s*90%/);
    expect(metricSlice(calmPaint, "disk")).toMatch(/width:\s*90%/);
    expect(metricSlice(calmPaint, "load")).toMatch(/width:\s*100%/);
    expect(metricSlice(calmPaint, "load")).not.toContain("bg-main");
    const calmSlots = slotRow(calmPaint);
    expect(calmSlots).toContain("bg-foreground");
    expect(calmSlots).toContain("bg-secondary-background");
    expect(calmSlots).not.toContain("bg-main");

    const hot = runnerDetailMarkup(
      {
        ...runner,
        slots: { used: 3, total: 3 },
        metrics: {
          ...runner.metrics!,
          cpuPercent: 91,
          memoryTotalBytes: 100,
          memoryAvailableBytes: 8,
          diskTotalBytes: 100,
          diskFreeBytes: 8,
          load1: 8.5,
          cpuCount: 8,
        },
      },
      view,
    );
    for (const metric of ["cpu", "memory", "disk", "load", "slots"])
      expect(hot).toContain(`data-metric="${metric}" data-level="warn"`);
    expect(hot).toContain('data-fill="91"');
    expect(hot.match(/data-fill="92"/g)).toHaveLength(2);
    expect(hot).toContain('data-fill="100"');
    expect(hot).toContain("8.50 of 8");
    expect(hot.match(/data-used="true"/g)).toHaveLength(3);
    expect(hot).not.toContain('data-used="false"');
    const hotPaint = painted(hot);
    for (const metric of ["cpu", "memory", "disk", "load"])
      expect(metricSlice(hotPaint, metric)).toContain("bg-main");
    expect(metricSlice(hotPaint, "cpu")).toMatch(/width:\s*91%/);
    expect(metricSlice(hotPaint, "memory")).toMatch(/width:\s*92%/);
    expect(metricSlice(hotPaint, "disk")).toMatch(/width:\s*92%/);
    expect(metricSlice(hotPaint, "load")).toMatch(/width:\s*100%/);
    const hotSlots = slotRow(hotPaint);
    expect(hotSlots).toContain("bg-main");
    expect(hotSlots).not.toContain("bg-secondary-background");
  });

  test("a runner without cpuCount shows load as a number", () => {
    const html = runnerDetailMarkup(runner, view);
    const load = html.slice(html.indexOf('data-metric="load"'));
    const meter = load.slice(0, load.indexOf("</div></div>") + "</div></div>".length);
    expect(meter).toContain(">0.50<");
    expect(meter).not.toContain("meter-track");
    expect(meter).not.toContain("of ");
  });

  test("a sample older than two heartbeats looks stale", () => {
    const edge = runnerDetailMarkup(
      { ...runner, metrics: { ...runner.metrics!, reportedAt: now - 30_000 } },
      view,
    );
    expect(edge).toContain('data-fresh="live"');
    expect(edge).not.toContain("Stale");
    const stale = runnerDetailMarkup(
      {
        ...runner,
        metrics: { ...runner.metrics!, cpuPercent: 99, reportedAt: now - 30_001 },
      },
      view,
    );
    expect(stale).toContain('data-metric="cpu" data-level="warn" data-fresh="stale"');
    expect(stale).toContain("Stale · Updated 30 s ago");
    expect(stale).not.toContain('data-fresh="live"');
    const stalePaint = metricSlice(painted(stale), "cpu");
    expect(stalePaint).toContain("bg-foreground/45");
    expect(stalePaint).not.toMatch(/bg-foreground(?!\/)/);
    expect(stalePaint).not.toContain("bg-main");
    const staleSlots = runnerDetailMarkup(
      {
        ...runner,
        slots: { used: 2, total: 2 },
        metrics: { ...runner.metrics!, reportedAt: now - 30_001 },
      },
      view,
    );
    expect(staleSlots).toContain('data-metric="slots" data-level="warn" data-fresh="live"');
    expect(metricSlice(painted(staleSlots), "cpu")).toContain("bg-foreground/45");
    expect(metricSlice(painted(staleSlots), "slots")).toContain("bg-main");
  });

  test("the card does not scroll sideways at 390 px", () => {
    const card = runnerDetailMarkup(
      {
        ...runner,
        name: "build-box-with-a-very-long-host-name-that-must-wrap",
        slots: { used: 16, total: 16 },
        concurrency: { desired: 10, applied: 10, ceiling: 16 },
      },
      view,
    );
    const body = renderToStaticMarkup(createElement(Fragment, null, themedMarkup(card)));
    const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");
    expect(body).toContain('data-runner-card="');
    expect(body).toContain("min-w-0");
    expect(body).toContain("flex-wrap");
    expect(body).toContain("[overflow-wrap:anywhere]");
    expect(body).not.toMatch(/min-w-\[(?:[4-9]\d{2}|\d{4,})px\]/);
    const nowrap = [...body.matchAll(/whitespace-nowrap[^>]*>([^<]*)</g)].map((match) =>
      (match[1] ?? "").trim(),
    );
    expect(nowrap.length).toBeGreaterThan(0);
    for (const label of nowrap) expect(label.length).toBeLessThan(24);
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toContain("max-width: 100%");
    const text = body.replace(/<[^>]+>/g, " ");
    const widest = Math.max(
      ...text
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => word.length),
    );
    expect(widest).toBeGreaterThan(40);
    expect(widest * 8).toBeGreaterThan(390);
  });
});

test("runner actions share one row and resume a paused runner", () => {
  const html = runnerActionsMarkup(
    { id: "runner-1", status: "paused" },
    { manages: true, busy: false },
  );
  expect(html.startsWith('<div class="row">')).toBe(true);
  expect(html).toContain(">Resume<");
  expect(html.indexOf("Resume")).toBeLessThan(html.indexOf("Revoke access"));
  expect(
    runnerActionsMarkup({ id: "runner-1", status: "active" }, { manages: true, busy: true }),
  ).toContain(" disabled");
});

test("versions compare numerically", () => {
  expect(compareVersions("1.9.0", "1.10.0")).toBe(-1);
  expect(compareVersions("v2.0", "2.0.0")).toBe(0);
  expect(compareVersions("2.1.0", "2.0.5")).toBe(1);
  expect(compareVersions("dev", "1.0.0")).toBeNull();
});

describe("live polling", () => {
  function fakes() {
    const listeners = new Set<() => void>();
    const doc = {
      visibilityState: "visible" as DocumentVisibilityState,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    };
    let handler: (() => void) | null = null;
    let every = 0;
    const timers = {
      setInterval: (next: () => void, ms: number) => {
        handler = next;
        every = ms;
        return 1;
      },
      clearInterval: () => {
        handler = null;
      },
    };
    return {
      doc,
      timers,
      listeners,
      fire: () => handler?.(),
      every: () => every,
      running: () => handler !== null,
    };
  }

  test("refreshes on an interval only while the page is visible", () => {
    const fake = fakes();
    let ticks = 0;
    const stop = livePoll(() => ticks++, fake.doc as never, fake.timers as never);
    expect(fake.every()).toBe(RUNNER_POLL_MS);
    fake.fire();
    expect(ticks).toBe(1);
    fake.doc.visibilityState = "hidden";
    fake.fire();
    for (const listener of fake.listeners) listener();
    expect(ticks).toBe(1);
    fake.doc.visibilityState = "visible";
    for (const listener of fake.listeners) listener();
    expect(ticks).toBe(2);
    stop();
    expect(fake.running()).toBe(false);
    expect(fake.listeners.size).toBe(0);
  });
});
