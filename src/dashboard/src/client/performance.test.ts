import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { apiLevel, createPerformance, formatMs, lagLevel } from "./performance";
import { settleReactWork } from "./settle-react";

const point = (at: number, p95: number, gauge: number | null = null) => ({
  ...{ at, count: 10, sum: p95 * 10, max: p95 * 2, gauge, p50: p95, p95, p99: p95 },
  atMostMs: null,
});

test("renders every section from fixture data, refetches on a new range and shows an empty range", async () => {
  const window = new Window({ url: "http://127.0.0.1:8787/dashboard/workspace/performance" });
  const globals = ["window", "document", "Element", "HTMLElement", "Event"] as const;
  const saved = globals.map((name) => globalThis[name]);
  const realFetch = globalThis.fetch;
  const calls: URL[] = [];
  const now = Date.now();
  try {
    for (const name of globals)
      (globalThis as Record<string, unknown>)[name] =
        name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
    globalThis.fetch = (async (url: URL | string) => {
      const target = new URL(String(url));
      calls.push(target);
      const empty =
        target.searchParams.get("step") === "minute" ||
        Number(target.searchParams.get("from")) > now - 2 * 3_600_000;
      if (target.pathname === "/api/metrics/stages")
        return Response.json({
          items: empty
            ? []
            : [
                {
                  ...{ itemId: "i1", identifier: "PAS-1", title: "Slow one", state: "merged" },
                  stagesMs: {
                    queued: 60_000,
                    running: 600_000,
                    verifying: 300_000,
                    awaitingInput: 0,
                    mergeQueue: 120_000,
                  },
                },
              ],
          checks: empty
            ? []
            : [{ checkId: "test", runs: 3, timeouts: 0, medianMs: 90_000, p95Ms: 120_000 }],
        });
      const series = (name: string, labels: Record<string, string>, value: number) => ({
        name,
        labels,
        points: [point(now - 7_200_000, value, value), point(now - 3_600_000, value, value)],
      });
      return Response.json({
        step: "hour",
        from: now - 86_400_000,
        to: now,
        series: empty
          ? []
          : [
              series("process.event_loop_lag", {}, 40),
              series("process.cpu_percent", {}, 12),
              series("process.rss_bytes", {}, 300 * 1024 ** 2),
              series("host.operation", { operation: "closeout.report" }, 250),
              series("http.request", { route: "/api/issues", status_class: "2xx" }, 120),
              series("linear.call", { caller: "poll", status_class: "2xx" }, 400),
              series("github.call", { caller: "pulls", status_class: "5xx" }, 900),
              series("github.rate_remaining", {}, 4_100),
              series("job.depth", { queue: "merge" }, 2),
              series("job.oldest_age_ms", { queue: "merge" }, 30_000),
              series("job.wait", { queue: "merge" }, 500),
            ],
      });
    }) as typeof fetch;
    const root = window.document.createElement("div") as unknown as HTMLElement;
    window.document.body.appendChild(root as never);
    createPerformance().mount(root, "http://127.0.0.1:8787");
    await settleReactWork();

    expect(calls.map((call) => call.pathname).sort()).toEqual([
      "/api/metrics",
      "/api/metrics/stages",
    ]);
    expect(calls[0]!.searchParams.get("step")).toBe("hour");
    for (const name of ["work", "responsiveness", "queues", "services"])
      expect(root.querySelector(`[data-perf-section="${name}"]`)).not.toBeNull();
    expect(root.querySelectorAll("[data-perf-tile]").length).toBe(4);
    expect(root.querySelectorAll("[data-perf-chart]").length).toBe(3);
    const text = root.textContent ?? "";
    expect(text).toContain("PAS-1");
    expect(text).toContain("closeout.report");
    expect(text).toContain("Job: merge");
    expect(text).toContain("4100");
    expect(root.querySelector('a[href$="/issues/i1"]')).not.toBeNull();

    (root.querySelector('[data-perf-range="1h"]') as unknown as { click(): void }).click();
    await settleReactWork();
    expect(calls.length).toBe(4);
    expect(calls[2]!.searchParams.get("step")).toBe("minute");
    expect(root.querySelector("[data-perf-empty]")?.textContent).toBe("No data in this range");
    expect(root.querySelector('[data-perf-range="1h"]')?.getAttribute("aria-pressed")).toBe("true");
  } finally {
    globalThis.fetch = realFetch;
    globals.forEach((name, index) => {
      (globalThis as Record<string, unknown>)[name] = saved[index];
    });
    await window.happyDOM.close();
  }
});

test("labels thresholds and durations", () => {
  expect([lagLevel(99), lagLevel(100), lagLevel(1_001)]).toEqual(["ok", "warn", "bad"]);
  expect([apiLevel(299), apiLevel(2_000), apiLevel(2_001)]).toEqual(["ok", "warn", "bad"]);
  expect([formatMs(42), formatMs(1_500), formatMs(600_000), formatMs(7_200_000)]).toEqual([
    "42 ms",
    "1.5 s",
    "10 min",
    "2.0 h",
  ]);
});

test("breaks the work down by repository and picks one repository", async () => {
  const window = new Window({ url: "http://127.0.0.1:8787/dashboard/workspace/performance" });
  const globals = ["window", "document", "Element", "HTMLElement", "Event"];
  const saved = globals.map((name) => (globalThis as Record<string, unknown>)[name]);
  const realFetch = globalThis.fetch;
  const stages: URL[] = [];
  const now = Date.now();
  const repository = (name: string, failures: number) => ({
    ...{ repository: name, issues: 4, merged: 2, medianTotalMs: 7_200_000 },
    medianStagesMs: { verifying: 600_000 },
    ...{ medianWaitingForPersonMs: 60_000, avgCloseoutRounds: 1.5, checkRuns: 8 },
    ...{ checkFailures: failures, slowestCheck: { checkId: "test", medianMs: 90_000 } },
  });
  try {
    for (const name of globals)
      (globalThis as Record<string, unknown>)[name] =
        name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
    globalThis.fetch = (async (url: URL | string) => {
      const target = new URL(String(url));
      if (target.pathname !== "/api/metrics/stages")
        return Response.json({ step: "hour", from: now - 86_400_000, to: now, series: [] });
      stages.push(target);
      const picked = target.searchParams.get("repository");
      return Response.json({
        items: [],
        checks: [
          { checkId: "test", runs: 3, failures: 1, timeouts: 0, medianMs: 90_000, p95Ms: 1 },
        ],
        repositories: picked
          ? [repository(picked, 2)]
          : [repository("acme/api", 2), repository("acme/web", 0)],
      });
    }) as typeof fetch;
    const root = window.document.createElement("div") as unknown as HTMLElement;
    window.document.body.appendChild(root as never);
    createPerformance().mount(root, "http://127.0.0.1:8787");
    await settleReactWork();

    expect(stages[0]!.searchParams.has("repository")).toBe(false);
    const rows = [...root.querySelectorAll("tr[data-perf-repository]")];
    expect(rows.map((row) => row.getAttribute("data-perf-repository"))).toEqual([
      "acme/api",
      "acme/web",
    ]);
    expect(rows[0]!.textContent).toContain("2 of 8 runs");
    expect(root.querySelector('[data-perf-section="repositories"]')?.textContent).toContain(
      "By repository",
    );
    const checks = [...root.querySelectorAll('[data-perf-section="work"] tr')];
    expect(checks.find((row) => row.textContent?.includes("1 of 3"))).toBeDefined();
    expect(root.querySelector("[data-perf-workspace-note]")).toBeNull();
    expect(
      [...root.querySelectorAll("select[data-perf-repository] option")].map((o) => o.textContent),
    ).toEqual(["All repositories", "acme/api", "acme/web"]);

    (root.querySelector('[data-perf-pick="acme/api"]') as unknown as { click(): void }).click();
    await settleReactWork();
    expect(stages.at(-1)!.searchParams.get("repository")).toBe("acme/api");
    expect(new URL(window.location.href).searchParams.get("repository")).toBe("acme/api");
    expect(root.querySelector('[data-perf-section="repositories"]')).toBeNull();
    expect(root.querySelector("#perf-work")?.textContent).toContain("acme/api");
    const notes = [...root.querySelectorAll("[data-perf-workspace-note]")];
    expect(
      notes.map((note) => note.closest("[data-perf-section]")?.getAttribute("data-perf-section")),
    ).toEqual(["responsiveness", "queues", "services"]);
    expect(notes[0]!.textContent).toBe("For the whole workspace");

    createPerformance().mount(
      window.document.createElement("div") as unknown as HTMLElement,
      "http://127.0.0.1:8787",
    );
    await settleReactWork();
    expect(stages.at(-1)!.searchParams.get("repository")).toBe("acme/api");
  } finally {
    globalThis.fetch = realFetch;
    globals.forEach((name, index) => {
      (globalThis as Record<string, unknown>)[name] = saved[index];
    });
    await window.happyDOM.close();
  }
});
