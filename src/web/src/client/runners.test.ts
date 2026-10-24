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
    identifier: "ENG-7",
    title: "Parse config files",
    agent: "claude",
    resolvedModel: "claude-opus",
    purpose: "work",
    outcome: "success",
    startedAt: now - 125_000,
    endedAt: now,
  };

  test("lists each execution with its issue, agent, duration and outcome", () => {
    const html = runnerHistoryMarkup([
      entry,
      {
        ...entry,
        commandId: "command-2",
        runId: null,
        identifier: null,
        title: null,
        agent: null,
        resolvedModel: null,
        purpose: "check",
        outcome: null,
        endedAt: null,
      },
    ]);
    expect(html).toContain(
      '<a class="work-title" href="/issues/ENG-7"><span class="lin-id">ENG-7</span> Parse config files</a><p class="muted">Work</p>',
    );
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

  test("a runner with one session links its issue to the issue page", () => {
    const html = runnerRunningMarkup([working], now);
    expect(html).toContain('aria-label="Running issues"');
    expect(html).toContain(
      '<a class="work-title" href="/issues/ENG-7"><span class="lin-id">ENG-7</span> Parse &lt;config&gt; files</a>',
    );
    expect(html).toContain('<span class="st running">Working</span>');
    expect(html).toContain(">12m</span>");
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
    expect(html).toContain('href="/issues/ENG-9"');
    expect(html).toContain('<span class="st verifying">Closeout</span>');
    expect(html).toContain(">1h 15m</span>");
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
    expect(labels[0]).toContain(">under a minute</span>");
  });

  test("the runner card lists every session to members and observers alike", () => {
    const busy = {
      ...runner,
      idle: false,
      slots: { used: 2, total: 3 },
      running: [working, closeout],
    };
    for (const role of ["owner", "member", "observer"]) {
      const html = runnerDetailMarkup(busy, { ...view, userId: "someone", role });
      const slots =
        /<section class="runner-block" aria-labelledby="[^"]+-slots">.*?<\/section>/.exec(
          html,
        )?.[0];
      expect(slots?.match(/data-running-run=/g)).toHaveLength(2);
      expect(slots).toContain('<span class="lin-id">ENG-7</span>');
      expect(slots).toContain('href="/issues/ENG-7"><span class="lin-id">ENG-7</span>');
      expect(slots).toContain('<span class="st running">Working</span>');
      expect(slots).toContain(">12m</span>");
      expect(slots).toContain('<span class="lin-id">ENG-9</span>');
      expect(slots).toContain('<span class="st verifying">Closeout</span>');
      expect(slots).toContain(">1h 15m</span>");
      expect(slots).not.toContain("<button");
    }
    const idle = runnerDetailMarkup(
      { ...runner, slots: { used: 0, total: 1 }, running: [] },
      { ...view, role: "observer" },
    );
    expect(idle).toContain("Nothing running");
    expect(idle).not.toContain("data-running-run=");
  });

  test("free slots collapse into one row after the busy ones", () => {
    const some = runnerRunningMarkup([working], now, { used: 1, total: 3 });
    expect(some.match(/<li /g)).toHaveLength(2);
    expect(some).toContain('<span class="slot-mark used" aria-hidden="true">');
    expect(some).toContain(">2 slots free</span>");
    expect(runnerRunningMarkup([], now, { used: 0, total: 1 })).toContain(
      ">Nothing running · 1 slot free</span>",
    );
    const full = runnerRunningMarkup([working, closeout], now, { used: 2, total: 2 });
    expect(full.match(/class="slot-mark used high"/g)).toHaveLength(2);
    expect(full).not.toContain("free");
    const prepare = runnerRunningMarkup([working], now, { used: 3, total: 4 });
    expect(prepare).toContain(">2 more slots busy</span>");
    expect(prepare).toContain(">1 slot free</span>");
    expect(runnerRunningMarkup([], now, { used: 1, total: 1 })).toContain(">1 slot busy</span>");
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
    expect(html).toContain(
      "<span>Runner 1.2.0</span><span>ubuntu 24.04</span><span>Seen 5 s ago</span>",
    );
    expect(html).not.toContain("Update available");
    expect(html).toContain(">42%<");
    expect(html).toContain("12 GB of 16 GB");
    expect(html).toContain(">0.50<");
    expect(html).toContain("5 min 0.25 · 15 min 0.13");
    expect(html).toContain("40 GB free of 100 GB");
    expect(runnerDetailMarkup({ ...runner, slots: { used: 2, total: 10 } }, view)).toContain(
      `<h3 id="runner-${runner.id}-slots">Running issues</h3><span class="gauge-value">2 of 10 slots in use</span>`,
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

  test("stray processes are listed with their age and CPU, busiest flagged", () => {
    expect(runnerDetailMarkup(runner, view)).not.toContain("Stray processes");
    const html = runnerDetailMarkup(
      {
        ...runner,
        metrics: {
          ...runner.metrics!,
          strayProcesses: [
            { pid: 4242, name: "bun", ageSeconds: 5 * 3600, cpuPercent: 160.4 },
            { pid: 77, name: "<bg>", ageSeconds: 90, cpuPercent: 0 },
          ],
        },
      },
      view,
    );
    expect(html).toContain(`<h3 id="runner-${runner.id}-strays">Stray processes</h3>`);
    expect(html).toContain('data-stray-pid="4242"');
    expect(html).toContain(
      '<span class="gauge-value high">160% CPU<span class="sr-only">, high</span>',
    );
    expect(html).toContain('data-stray-pid="77"');
    expect(html).toContain("&lt;bg&gt;");
    expect(html).toContain('<span class="gauge-value">0% CPU</span>');
    expect(html).toContain("PID 4242");
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
    expect(html).toContain("<span>Seen 5 min ago</span>");
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

  test("only the host owner signs in to the agents from the runner card", () => {
    expect(runnerDetailMarkup(runner, view)).toContain(`data-runner-signin="${runner.id}"`);
    for (const role of ["admin", "member"])
      expect(runnerDetailMarkup(runner, { ...view, userId: "someone", role })).not.toContain(
        "data-runner-signin",
      );
    expect(runnerDetailMarkup(runner, { ...view, role: "observer" })).not.toContain(
      "data-runner-signin",
    );
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
        expect(html).toContain(
          '<h3>Concurrency</h3><div><form class="row" data-runner-concurrency=',
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
          '<h3>Concurrency</h3><div>2 <span class="muted">Host limit 4. Runner applied 2.</span></div>',
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
        "<h3>Concurrency</h3>",
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

  test("the slot count turns orange when all slots are in use", () => {
    const some = runnerDetailMarkup({ ...runner, slots: { used: 1, total: 3 } }, view);
    expect(some).toContain('<span class="gauge-value">1 of 3 slots in use</span>');
    const full = runnerDetailMarkup({ ...runner, slots: { used: 3, total: 3 } }, view);
    expect(full).toContain('<span class="gauge-value high">3 of 3 slots in use</span>');
  });

  test("metrics older than two heartbeats look stale", () => {
    const fresh = card({ reportedAt: now - 30_000 });
    expect(fresh).toContain("<span>Seen 30 s ago</span>");
    expect(fresh).not.toContain("Stale");
    expect(fresh).toContain('<dl class="runner-gauges">');
    const stale = card({ reportedAt: now - 31_000 });
    expect(statusLine(stale)).toBe('<span class="tag ok">Idle</span><span>Stale</span>');
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
      `<h3 id="runner-${runner.id}-agents">Agents</h3><button class="btn" data-runner-signin=`,
    );
    expect(html).toContain(
      '<li class="runner-agent" data-agent="claude"><span class="runner-agent-name"><b>Claude</b><span class="tag ok">Signed in</span></span><p class="muted">Usage not reported</p></li><li class="runner-agent" data-agent="codex"><span class="runner-agent-name"><b>Codex</b><span class="tag ">Not checked</span></span></li>',
    );
  });

  test("agent usage shows one bar per window, orange from 90 percent", () => {
    const html = runnerDetailMarkup(
      {
        ...runner,
        agents: [
          {
            agent: "claude",
            status: "signed_in",
            checkedAt: now,
            limits: [
              { window: "5-hour", usedPercent: 7, resetsAt: now + 3_600_000 },
              { window: "Weekly", usedPercent: 92, resetsAt: null },
            ],
          },
          {
            agent: "codex",
            status: "signed_out",
            checkedAt: now,
            limits: [{ window: "Weekly", usedPercent: 10, resetsAt: null }],
          },
        ],
      },
      view,
    );
    expect(gauge(html, "5-hour")).toContain('<span class="gauge-value">7% used</span>');
    expect(gauge(html, "5-hour")).toContain('data-fill="7"');
    expect(gauge(html, "5-hour")).toContain("Resets ");
    expect(gauge(html, "weekly")).toContain('data-level="high"');
    expect(gauge(html, "weekly")).not.toContain("Resets");
    expect(html.match(/data-gauge="weekly"/g)).toHaveLength(1);
    expect(html).not.toContain("As of");
  });

  test("stored usage says how old it is and drops windows that have reset since", () => {
    const html = runnerDetailMarkup(
      {
        ...runner,
        agents: [
          {
            agent: "claude",
            status: "signed_in",
            checkedAt: now,
            limitsAt: now - 12 * 60_000,
            limits: [
              { window: "5-hour", usedPercent: 80, resetsAt: now - 1 },
              { window: "Weekly", usedPercent: 30, resetsAt: now + 86_400_000 },
            ],
          },
        ],
      },
      view,
    );
    expect(html).toContain('<p class="muted">As of 12 min ago</p>');
    expect(gauge(html, "5-hour")).toBe("");
    expect(gauge(html, "weekly")).toContain("30% used");
    const reset = runnerDetailMarkup(
      {
        ...runner,
        agents: [
          {
            agent: "claude",
            status: "signed_in",
            checkedAt: now,
            limitsAt: now - 60_000,
            limits: [{ window: "5-hour", usedPercent: 80, resetsAt: now - 1 }],
          },
        ],
      },
      view,
    );
    expect(reset).toContain("Usage not reported");
  });

  test("heartbeats in a second render update the values in place", () => {
    const first = runnerDetailMarkup(runner, view);
    const next = runnerDetailMarkup(
      { ...runner, metrics: { ...runner.metrics!, cpuPercent: 97, reportedAt: now + 10_000 } },
      { ...view, now: now + 12_000 },
    );
    expect(first).toContain('data-fill="42"');
    expect(next).toContain('data-fill="97"');
    expect(next).toContain("<span>Seen 2 s ago</span>");
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

test("pause sits in the card header and resumes a paused runner", () => {
  const html = runnerDetailMarkup({ ...runner, status: "paused" }, view);
  expect(html).toMatch(
    /<\/div><button class="btn" data-runner-status="active"[^>]*>Resume<\/button><\/div>/,
  );
  expect(html).not.toContain(">Pause<");
});

test("drain and revoke share one row in settings", () => {
  const html = runnerActionsMarkup(
    { id: "runner-1", status: "paused" },
    { manages: true, busy: false },
  );
  expect(html.startsWith('<div class="row">')).toBe(true);
  expect(html.indexOf("Drain")).toBeLessThan(html.indexOf("Revoke access"));
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
