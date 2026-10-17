import { describe, expect, test } from "bun:test";
import {
  compareVersions,
  livePoll,
  RUNNER_POLL_MS,
  runnerActionsMarkup,
  runnerCardMarkup,
  type Runner,
} from "./runners";

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
    agents: [{ agent: "claude", seat: "organization" }],
  },
  userId: "owner",
  role: "owner",
  busy: false,
  recent: true,
};

describe("runner cards", () => {
  test("an idle runner shows its host metrics, sign-in, account type and controls", () => {
    const html = runnerCardMarkup(runner, view);
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
    expect(html).toContain('<span class="tag ok">Signed in</span>');
    expect(html).toContain('<span class="tag ">Not checked</span>');
    expect(html).toMatch(/data-agent="claude"[^>]*>.*<option value="organization" selected>/);
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
    const html = runnerCardMarkup({ ...runner, idle: false }, view);
    expect(html).toContain('<span class="tag running">Busy</span>');
    expect(html).not.toContain(">Idle<");
  });

  test("an offline runner says when it was last seen and hides idle or busy", () => {
    const html = runnerCardMarkup(
      { ...runner, idle: false, metrics: { ...runner.metrics!, reportedAt: now - 5 * 60_000 } },
      view,
    );
    expect(html).toContain('<span class="tag bad">Offline</span>');
    expect(html).toContain("5m ago");
    expect(html).not.toContain("Busy");
    expect(html).not.toContain("Idle");
  });

  test("a runner that never reported is offline", () => {
    const html = runnerCardMarkup({ ...runner, metrics: null, os: null, version: null }, view);
    expect(html).toContain("Offline");
    expect(html).toContain("<dt>Last seen</dt><dd>Never</dd>");
    expect(html).toContain("<dt>CPU</dt><dd>Not reported</dd>");
  });

  test("a signed-out agent and an older runner version are flagged", () => {
    const html = runnerCardMarkup(
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
    const html = runnerCardMarkup(runner, { ...view, userId: "someone", role: "member" });
    expect(html).toMatch(/data-runner-sharing="[^"]+"[^>]* disabled/);
    expect(html).toContain("The host owner controls its sharing settings.");
    expect(html).not.toContain(">Pause<");
  });

  test("a revoked runner has no settings or controls", () => {
    const html = runnerCardMarkup({ ...runner, status: "revoked" }, view);
    expect(html).toContain("Revoked");
    expect(html).toContain("Offline");
    expect(html).not.toContain("data-runner-seat");
    expect(html).not.toContain("data-runner-sharing");
    expect(html).not.toContain("data-runner-status");
  });
});

test("runner actions share one row and resume a paused runner", () => {
  const html = runnerActionsMarkup(
    { id: "runner-1", status: "paused" },
    { manages: true, busy: false, recent: true },
  );
  expect(html.startsWith('<div class="row">')).toBe(true);
  expect(html).toContain(">Resume<");
  expect(html.indexOf("Resume")).toBeLessThan(html.indexOf("Revoke access"));
  expect(
    runnerActionsMarkup(
      { id: "runner-1", status: "active" },
      { manages: true, busy: true, recent: true },
    ),
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
