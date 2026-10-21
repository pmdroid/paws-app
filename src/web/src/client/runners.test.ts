import { describe, expect, test } from "bun:test";
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

  test("the model line shows the entry's label", () => {
    const html = runnerHistoryMarkup([
      { ...entry, resolvedModel: "opus[1m]", modelLabel: "Opus 5.5 · 1M context" },
    ]);
    expect(html).toContain('<p class="muted">Opus 5.5 · 1M context</p>');
    expect(html).not.toContain("opus[1m]");
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
      '<span class="tag">Idle</span>',
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
    expect(runnerDetailMarkup(busy, view)).toContain('<span class="tag running">Running 1</span>');
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
    expect(html).toContain("Just now");
    expect(html).toContain("ubuntu 24.04");
    expect(html).toContain("42%");
    expect(html).toContain("12 GB used of 16 GB");
    expect(html).toContain("0.50 / 0.25 / 0.13");
    expect(html).toContain("40 GB free of 100 GB");
    expect(runnerDetailMarkup({ ...runner, slots: { used: 2, total: 10 } }, view)).toContain(
      "<dt>Slots</dt><dd>2 of 10 in use</dd>",
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
    expect(html).toContain('<span class="tag running">Busy</span>');
    expect(html).not.toContain(">Idle<");
  });

  test("an offline runner says when it was last seen and hides idle or busy", () => {
    const html = runnerDetailMarkup(
      { ...runner, idle: false, metrics: { ...runner.metrics!, reportedAt: now - 5 * 60_000 } },
      view,
    );
    expect(html).toContain('<span class="tag bad">Offline</span>');
    expect(html).toContain("5m ago");
    expect(html).not.toContain("Busy");
    expect(html).not.toContain("Idle");
  });

  test("a runner that never reported is offline", () => {
    const html = runnerDetailMarkup({ ...runner, metrics: null, os: null, version: null }, view);
    expect(html).toContain("Offline");
    expect(html).toContain("<dt>Last seen</dt><dd>Never</dd>");
    expect(html).toContain("<dt>CPU</dt><dd>Not reported</dd>");
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
        expect(html).toContain("<dt>Slots</dt><dd>1 of 2 in use</dd><dt>Concurrency</dt>");
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
        expect(html).toContain(
          '<dt>Concurrency</dt><dd>2 <span class="muted">Host limit 4. Runner applied 2.</span></dd>',
        );
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
        "<dt>Concurrency</dt>",
      );
    });
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
