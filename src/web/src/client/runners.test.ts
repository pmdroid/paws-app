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
  updatedLabel,
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
/** The single status line under the runner name. */
function statusLine(html: string): string | undefined {
  return /<p class="runner-status">(.*?)<\/p>/.exec(html)?.[1];
}

/** One gauge's markup, from its `data-gauge` wrapper to the closing tag. */
function gauge(html: string, name: string): string {
  return (
    new RegExp(`<div class="runner-gauge" data-gauge="${name}"[^>]*>(?:(?!</div>).)*</div>`).exec(
      html,
    )?.[0] ?? ""
  );
}

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
      '<span class="tag ok">Idle</span>',
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
    expect(statusLine(html)).toBe('<span class="tag ok">Idle</span>');
    expect(html).not.toContain("Busy");
    expect(html).toContain("<span>Runner 1.2.0</span><span>ubuntu 24.04</span><span>Last seen ");
    expect(html).not.toContain("Update available");
    expect(html).toContain("Updated 5 s ago");
    expect(html).toContain(">42%<");
    expect(html).toContain("12 GB of 16 GB");
    expect(html).toContain(">0.50<");
    expect(html).toContain("5 min 0.25 · 15 min 0.13");
    expect(html).toContain("40 GB free of 100 GB");
    expect(runnerDetailMarkup({ ...runner, slots: { used: 2, total: 10 } }, view)).toContain(
      '<dt>Slots</dt><dd><span class="gauge-value">2 of 10 in use</span></dd>',
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
    expect(statusLine(html)).toBe('<span class="tag bad">Offline</span>');
    expect(html).toContain("Updated 5 min ago");
    expect(html).toContain("Last seen ");
    expect(html).not.toContain("Busy");
    expect(html).not.toContain("Idle");
  });

  test("a runner that never reported is offline", () => {
    const html = runnerDetailMarkup({ ...runner, metrics: null, os: null, version: null }, view);
    expect(statusLine(html)).toBe('<span class="tag bad">Offline</span>');
    expect(html).toContain(
      "<span>Version not reported</span><span>OS not reported</span><span>Never seen</span>",
    );
    expect(html).toContain("This runner has not reported host metrics yet.");
    expect(html).not.toContain('class="gauge"');
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
    expect(statusLine(html)).toBe('<span class="tag bad">Revoked</span>');
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
        expect(html).toMatch(
          /<dt>Slots<\/dt><dd><span class="gauge-value">1 of 2 in use<\/span><\/dd>.*<\/div><div class="runner-concurrency"><dt>Concurrency<\/dt>/,
        );
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

describe("live host metrics", () => {
  const metrics = { ...runner.metrics!, cpuCount: 4 };
  const card = (patch: Partial<NonNullable<Runner["metrics"]>>, extra: Partial<Runner> = {}) =>
    runnerDetailMarkup({ ...runner, ...extra, metrics: { ...metrics, ...patch } }, view);

  test("CPU, memory, disk and load show as bars at normal values", () => {
    const html = card({});
    expect(gauge(html, "cpu")).toContain('data-level="normal"');
    expect(gauge(html, "cpu")).toContain('<span class="gauge-value">42%</span>');
    expect(gauge(html, "cpu")).toContain('data-fill="42"');
    expect(gauge(html, "memory")).toContain('<span class="gauge-value">75%</span>');
    expect(gauge(html, "memory")).toContain('data-fill="75"');
    expect(gauge(html, "memory")).toContain("12 GB of 16 GB");
    expect(gauge(html, "disk")).toContain('<span class="gauge-value">60%</span>');
    expect(gauge(html, "disk")).toContain("40 GB free of 100 GB");
    expect(gauge(html, "load")).toContain('<span class="gauge-value">0.50</span>');
    expect(gauge(html, "load")).toContain('data-fill="13"');
    expect(gauge(html, "load")).toContain("4 cores");
    expect(html).not.toContain('data-level="high"');
    expect(html).not.toContain(", high");
  });

  test("each metric turns orange above its limit", () => {
    const high = card({
      cpuPercent: 95,
      memoryAvailableBytes: 1 * 1024 ** 3,
      diskFreeBytes: 5 * 1024 ** 3,
      load1: 4.5,
    });
    for (const name of ["cpu", "memory", "disk", "load"]) {
      expect(gauge(high, name)).toContain('data-level="high"');
      expect(gauge(high, name)).toContain('class="gauge-value high"');
      expect(gauge(high, name)).toContain('<span class="sr-only">, high</span>');
    }
    expect(gauge(high, "load")).toContain('data-fill="100"');
    const limits = card({
      cpuPercent: 90,
      memoryAvailableBytes: 1.6 * 1024 ** 3,
      diskFreeBytes: 10 * 1024 ** 3,
      load1: 4,
    });
    expect(limits).not.toContain('data-level="high"');
  });

  test("slots show one segment per slot and turn orange when all are in use", () => {
    const some = runnerDetailMarkup({ ...runner, slots: { used: 1, total: 3 } }, view);
    expect(gauge(some, "slots")).toContain(
      '<span class="slots" aria-hidden="true"><span class="slot used"></span><span class="slot"></span><span class="slot"></span></span>',
    );
    expect(gauge(some, "slots")).toContain('data-level="normal"');
    const full = runnerDetailMarkup({ ...runner, slots: { used: 3, total: 3 } }, view);
    expect(gauge(full, "slots").match(/class="slot used high"/g)).toHaveLength(3);
    expect(gauge(full, "slots")).toContain('class="gauge-value high"');
    expect(gauge(full, "slots")).toContain("all slots busy");
  });

  test("metrics older than two heartbeats look stale", () => {
    const fresh = card({ reportedAt: now - 30_000 });
    expect(fresh).toContain("Updated 30 s ago");
    expect(fresh).not.toContain("Stale");
    expect(fresh).toContain('<dl class="runner-gauges">');
    const stale = card({ reportedAt: now - 31_000 });
    expect(stale).toContain('<span class="tag warn">Stale</span> Updated 31 s ago');
    expect(stale).toContain('<dl class="runner-gauges stale">');
    expect(stale).toContain('aria-label="Host metrics" data-stale=""');
  });

  test("a runner without metrics says so instead of drawing empty bars", () => {
    const html = runnerDetailMarkup({ ...runner, metrics: null }, view);
    expect(html).toContain("This runner has not reported host metrics yet.");
    expect(html).not.toContain("runner-gauges");
    const partial = card({ cpuPercent: null, diskTotalBytes: null });
    expect(gauge(partial, "cpu")).toContain("Not reported");
    expect(gauge(partial, "cpu")).not.toContain('class="gauge"');
    expect(gauge(partial, "disk")).toContain("Not reported");
  });

  test("a runner without cpuCount shows load as a number", () => {
    for (const cpuCount of [undefined, null]) {
      const html = card({ cpuCount });
      expect(gauge(html, "load")).toContain('<span class="gauge-value">0.50</span>');
      expect(gauge(html, "load")).toContain("5 min 0.25 · 15 min 0.13");
      expect(gauge(html, "load")).not.toContain('class="gauge"');
      expect(gauge(html, "load")).toContain('data-level="normal"');
    }
    expect(gauge(card({ cpuCount: null, load1: 40 }), "load")).toContain('data-level="normal"');
  });
});

describe("simpler runner card", () => {
  test("one status line replaces the separate tags", () => {
    const html = runnerDetailMarkup(
      { ...runner, status: "draining", idle: false, version: "1.1.0" },
      view,
    );
    expect(statusLine(html)).toBe(
      '<span class="tag running">Busy</span><span>Draining</span><span>Update available</span>',
    );
    expect(html.match(/class="tag /g)?.length).toBe(
      1 + (runner.agents?.length ?? 0), // the status and one per agent
    );
  });

  test("the runner id sits behind a copy action instead of a chip", () => {
    const html = runnerDetailMarkup(runner, view);
    expect(html).toContain(
      `<button class="btn" data-runner-copy="${runner.id}" data-focus="copy:${runner.id}" title="${runner.id}" aria-label="Copy runner ID ${runner.id}">Copy ID</button>`,
    );
    expect(html).not.toContain(`<code>${runner.id}</code>`);
  });

  test("agents share one row with their sign-in state and the sign-in action", () => {
    const html = runnerDetailMarkup(runner, view);
    expect(html).toContain(
      '<ul class="runner-agent-list" role="list" aria-label="Agent sign-in"><li class="runner-agent"><b>Claude</b><span class="tag ok">Signed in</span></li><li class="runner-agent"><b>Codex</b><span class="tag ">Not checked</span></li></ul><button class="btn" data-runner-signin=',
    );
  });

  test("heartbeats in a second render update the values in place", () => {
    const first = runnerDetailMarkup(runner, view);
    const next = runnerDetailMarkup(
      { ...runner, metrics: { ...runner.metrics!, cpuPercent: 97, reportedAt: now + 10_000 } },
      { ...view, now: now + 12_000 },
    );
    expect(first).toContain('data-fill="42"');
    expect(next).toContain('data-fill="97"');
    expect(next).toContain("Updated 2 s ago");
    const gauges = (html: string) => [...html.matchAll(/data-gauge="([a-z]+)"/g)].map((m) => m[1]);
    expect(gauges(next)).toEqual(["cpu", "memory", "disk", "load"]);
    expect(gauges(next)).toEqual(gauges(first));
  });
});

test("updated labels count seconds, then minutes and hours", () => {
  expect(updatedLabel(now - 5_000, now)).toBe("5 s ago");
  expect(updatedLabel(now + 2_000, now)).toBe("0 s ago");
  expect(updatedLabel(now - 3 * 60_000, now)).toBe("3 min ago");
  expect(updatedLabel(now - 2 * 3_600_000, now)).toBe("2 h ago");
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
