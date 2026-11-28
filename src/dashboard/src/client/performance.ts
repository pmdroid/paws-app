import { esc } from "./format";
import { routeHref } from "./route";
import { renderMarkup } from "./theme";

type Point = { at: number; count: number; max: number; gauge: number | null; p95: number | null };
type Series = { name: string; labels: Record<string, string>; points: Point[] };
type StageKey = "queued" | "running" | "verifying" | "awaitingInput" | "mergeQueue";
type StageItem = {
  itemId: string;
  identifier: string | null;
  title: string | null;
  state?: string;
  stagesMs: Record<StageKey, number>;
};
type Check = {
  checkId: string;
  runs: number;
  failures?: number;
  timeouts: number;
  medianMs: number;
  p95Ms: number;
};
type Repository = {
  repository: string;
  issues: number;
  merged: number;
  medianTotalMs: number | null;
  medianStagesMs: Partial<Record<StageKey, number | null>>;
  medianWaitingForPersonMs: number | null;
  avgCloseoutRounds: number | null;
  checkRuns: number;
  checkFailures: number;
  slowestCheck: { checkId: string; medianMs: number } | null;
};
type Data = {
  from: number;
  to: number;
  series: Series[];
  items: StageItem[];
  checks: Check[];
  repositories?: Repository[];
};
type Level = "ok" | "warn" | "bad";

export const PERFORMANCE_RANGES = {
  "1h": { label: "1 h", ms: 60 * 60_000, step: "minute" },
  "24h": { label: "24 h", ms: 24 * 60 * 60_000, step: "hour" },
  "7d": { label: "7 d", ms: 7 * 24 * 60 * 60_000, step: "hour" },
} as const;
export type PerformanceRange = keyof typeof PERFORMANCE_RANGES;

const NAMES = [
  "process.event_loop_lag",
  "process.cpu_percent",
  "process.rss_bytes",
  "process.heap_used_bytes",
  "host.operation",
  "http.request",
  "linear.call",
  "github.call",
  "linear.rate_remaining",
  "github.rate_remaining",
  "job.wait",
  "job.depth",
  "job.oldest_age_ms",
  "outbox.wait",
  "outbox.depth",
  "outbox.oldest_age_ms",
];
const STAGES: { key: StageKey; label: string; color: string }[] = [
  { key: "queued", label: "Queued", color: "fill-state-awaiting bg-state-awaiting" },
  { key: "running", label: "Agent running", color: "fill-state-running bg-state-running" },
  { key: "verifying", label: "Closeout", color: "fill-state-recovering bg-state-recovering" },
  {
    key: "awaitingInput",
    label: "Waiting for a person",
    color: "fill-state-verifying bg-state-verifying",
  },
  { key: "mergeQueue", label: "Merge queue", color: "fill-state-ok bg-state-ok" },
];
const LEVEL_WORD: Record<Level, string> = { ok: "Good", warn: "Warning", bad: "Bad" };
const LEVEL_TEXT: Record<Level, string> = {
  ok: "text-state-ok",
  warn: "text-state-warn",
  bad: "text-state-failed",
};
const LEVEL_FILL: Record<Level, string> = {
  ok: "fill-state-ok",
  warn: "fill-state-warn",
  bad: "fill-state-failed",
};
const ICONS: Record<Level, string> = {
  ok: '<path d="M20 6 9 17l-5-5"></path>',
  warn: '<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path>',
  bad: '<circle cx="12" cy="12" r="10"></circle><path d="m15 9-6 6"></path><path d="m9 9 6 6"></path>',
};
const EMPTY = '<p class="sub">No data in this range</p>';

export const lagLevel = (ms: number): Level => (ms < 100 ? "ok" : ms <= 1_000 ? "warn" : "bad");
export const apiLevel = (ms: number): Level => (ms < 300 ? "ok" : ms <= 2_000 ? "warn" : "bad");
const cpuLevel = (percent: number): Level => (percent < 50 ? "ok" : percent <= 80 ? "warn" : "bad");
const mergeLevel = (ms: number): Level =>
  ms < 60 * 60_000 ? "ok" : ms <= 4 * 60 * 60_000 ? "warn" : "bad";
const waitLevel = (ms: number): Level => (ms < 1_000 ? "ok" : ms <= 30_000 ? "warn" : "bad");

export function formatMs(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 48 * 60 * 60_000) return `${(ms / 3_600_000).toFixed(1)} h`;
  return `${(ms / 86_400_000).toFixed(1)} d`;
}

const megabytes = (bytes: number) => `${Math.round(bytes / 1024 ** 2)} MB`;
const percent = (value: number) => `${Math.round(value)}%`;
const named = (data: Data, name: string) => data.series.filter((entry) => entry.name === name);
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function combine(series: Series[]) {
  const points = series.flatMap((entry) => entry.points);
  const count = sum(points.map((point) => point.count));
  const weighted = points.filter((point) => point.p95 !== null && point.count > 0);
  const total = sum(weighted.map((point) => point.count));
  return {
    count,
    max: Math.max(0, ...points.map((point) => point.max)),
    p95: total > 0 ? sum(weighted.map((point) => point.p95! * point.count)) / total : null,
  };
}

function groups(series: Series[], label: string): Map<string, Series[]> {
  return Map.groupBy(series, (entry) => entry.labels[label] ?? "other");
}

function timeline(series: Series[], value: (point: Point) => number | null) {
  const byTime = new Map<number, number>();
  for (const point of series.flatMap((entry) => entry.points)) {
    const next = value(point);
    if (next !== null) byTime.set(point.at, Math.max(byTime.get(point.at) ?? 0, next));
  }
  return [...byTime].sort(([a], [b]) => a - b).map(([at, v]) => ({ at, v }));
}

function latestGauge(series: Series[], data: Data, stepMs: number): number {
  return sum(
    series.map((entry) => {
      const last = entry.points.at(-1);
      return last && last.gauge !== null && last.at >= data.to - 2 * stepMs ? last.gauge : 0;
    }),
  );
}

function icon(level: Level): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[level]}</svg>`;
}

function status(level: Level | null): string {
  if (level === null) return '<span class="sub">—</span>';
  return `<span class="inline-flex items-center gap-1 ${LEVEL_TEXT[level]}">${icon(level)}${LEVEL_WORD[level]}</span>`;
}

function tile(
  name: string,
  value: number | null,
  shown: (v: number) => string,
  level: (v: number) => Level,
) {
  return `<div class="flex min-w-0 flex-col gap-1 rounded-base border border-border bg-secondary-background p-4" data-perf-tile><span class="sub">${name}</span><span class="font-mono text-2xl">${value === null ? "—" : shown(value)}</span>${status(value === null ? null : level(value))}</div>`;
}

function clockLabel(at: number, rangeMs: number): string {
  const iso = new Date(at).toISOString();
  return rangeMs > 24 * 60 * 60_000
    ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}`
    : iso.slice(11, 16);
}

function lineChart(
  title: string,
  points: { at: number; v: number }[],
  data: Data,
  shown: (v: number) => string,
  warnAt?: number,
): string {
  if (points.length === 0) return `<div class="col"><h3>${title}</h3>${EMPTY}</div>`;
  const top = Math.max(...points.map((point) => point.v), warnAt ? warnAt * 1.2 : 0) || 1;
  const x = (at: number) => ((at - data.from) / (data.to - data.from)) * 600;
  const y = (v: number) => 150 - (v / top) * 140;
  const path = points
    .map((point) => `${x(point.at).toFixed(1)},${y(point.v).toFixed(1)}`)
    .join(" ");
  const marks = points
    .map(
      (point) =>
        `<circle cx="${x(point.at).toFixed(1)}" cy="${y(point.v).toFixed(1)}" r="6" class="fill-transparent"><title>${clockLabel(point.at, data.to - data.from)} UTC: ${shown(point.v)}</title></circle>`,
    )
    .join("");
  const warn =
    warnAt === undefined
      ? ""
      : `<line x1="0" x2="600" y1="${y(warnAt)}" y2="${y(warnAt)}" class="stroke-state-warn" stroke-width="1" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"></line>`;
  const rows = points
    .map(
      (point) =>
        `<tr><td class="mono">${clockLabel(point.at, data.to - data.from)}</td><td class="mono">${shown(point.v)}</td></tr>`,
    )
    .join("");
  return `<figure class="col m-0" data-perf-chart><h3>${title}</h3><div class="between"><span class="sub mono">${shown(top)}</span>${warnAt === undefined ? "" : `<span class="sub">Dashed: warning at ${shown(warnAt)}</span>`}</div><svg viewBox="0 0 600 160" width="100%" height="160" preserveAspectRatio="none" class="overflow-visible"><line x1="0" x2="600" y1="150" y2="150" class="stroke-border" stroke-width="1" vector-effect="non-scaling-stroke"></line>${warn}<polyline points="${path}" fill="none" class="stroke-foreground" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"></polyline>${marks}</svg><div class="between"><span class="sub mono">${clockLabel(data.from, data.to - data.from)}</span><span class="sub mono">${clockLabel(data.to, data.to - data.from)} UTC</span></div><details><summary>Table view</summary><div class="overflow-x-auto [&_td]:[overflow-wrap:normal]"><table class="run-table"><thead><tr><th>Time (UTC)</th><th>${title}</th></tr></thead><tbody>${rows}</tbody></table></div></details></figure>`;
}

function bar(value: number, top: number, level: Level | null): string {
  const width = top > 0 ? Math.max(1, (value / top) * 100) : 0;
  return `<svg viewBox="0 0 100 8" width="100%" height="8" preserveAspectRatio="none" class="min-w-16"><rect x="0" y="0" width="${width.toFixed(1)}" height="8" rx="2" class="${level ? LEVEL_FILL[level] : "fill-muted-foreground"}"></rect></svg>`;
}

function table(head: string[], rows: string[][], rowAttrs: string[] = []): string {
  return `<div class="overflow-x-auto [&_td]:[overflow-wrap:normal] [&_th]:whitespace-nowrap"><table class="run-table"><thead><tr>${head.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead><tbody>${rows.map((row, index) => `<tr${rowAttrs[index] ?? ""}>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function section(id: string, title: string, body: string, note = false): string {
  return `<section class="overview-section" aria-labelledby="perf-${id}" data-perf-section="${id}"><h2 id="perf-${id}">${title}</h2>${note ? '<p class="sub" data-perf-workspace-note>For the whole workspace</p>' : ""}${body}</section>`;
}

const maybeMs = (ms: number | null | undefined) =>
  `<span class="mono">${ms == null ? "—" : formatMs(ms)}</span>`;

function repositoryTable(repositories: Repository[]): string {
  const rows = repositories.map((row) => [
    `<button class="btn sm min-h-11 mono" type="button" data-perf-pick="${esc(row.repository)}">${esc(row.repository)}</button>`,
    `<span class="mono">${row.issues}</span>`,
    `<span class="mono">${row.merged}</span>`,
    maybeMs(row.medianTotalMs),
    maybeMs(row.medianStagesMs.verifying),
    `<span class="mono">${row.avgCloseoutRounds === null ? "—" : row.avgCloseoutRounds.toFixed(1)}</span>`,
    `<span class="mono">${row.checkFailures} of ${row.checkRuns} runs</span>`,
    maybeMs(row.medianWaitingForPersonMs),
    row.slowestCheck
      ? `<span class="mono">${esc(row.slowestCheck.checkId)} ${formatMs(row.slowestCheck.medianMs)}</span>`
      : "—",
  ]);
  return section(
    "repositories",
    "By repository",
    rows.length
      ? table(
          [
            "Repository",
            "Issues",
            "Merged",
            "Median total",
            "Median Closeout",
            "Closeout rounds",
            "Check failures",
            "Waiting for a person",
            "Slowest check",
          ],
          rows,
          repositories.map((row) => ` data-perf-repository="${esc(row.repository)}"`),
        )
      : EMPTY,
  );
}

function callRows(series: Series[], label: string, top = 15): string[][] {
  const rows = [...groups(series, label)].map(([name, entries]) => {
    const all = combine(entries);
    const failed = combine(
      entries.filter((entry) => !/^[23]xx$/.test(entry.labels.status_class ?? "")),
    );
    return { name, ...all, errors: all.count > 0 ? (failed.count / all.count) * 100 : 0 };
  });
  rows.sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0) || a.name.localeCompare(b.name));
  const highest = Math.max(0, ...rows.map((row) => row.p95 ?? 0));
  return rows
    .slice(0, top)
    .map((row) => [
      `<span class="mono">${esc(row.name)}</span>`,
      `<span class="mono">${row.count}</span>`,
      `<span class="mono">${row.p95 === null ? "—" : formatMs(row.p95)}</span>`,
      row.p95 === null ? "" : bar(row.p95, highest, apiLevel(row.p95)),
      `<span class="mono">${row.errors.toFixed(1)}%</span>`,
    ]);
}

function stageBar(medians: { key: StageKey; label: string; color: string; ms: number }[]): string {
  const total = sum(medians.map((stage) => stage.ms));
  if (total <= 0) return EMPTY;
  let left = 0;
  const rects = medians
    .filter((stage) => stage.ms > 0)
    .map((stage) => {
      const width = (stage.ms / total) * 1000;
      const rect = `<rect x="${left.toFixed(1)}" y="0" width="${Math.max(0, width - 2).toFixed(1)}" height="24" rx="4" class="${stage.color}"><title>${stage.label}: ${formatMs(stage.ms)}</title></rect>`;
      left += width;
      return rect;
    })
    .join("");
  const legend = medians
    .map(
      (stage) =>
        `<li class="inline-flex items-center gap-2"><span class="inline-block size-3 rounded-sm ${stage.color}"></span>${stage.label} <span class="mono">${formatMs(stage.ms)}</span></li>`,
    )
    .join("");
  return `<svg viewBox="0 0 1000 24" width="100%" height="24" preserveAspectRatio="none">${rects}</svg><ul class="flex list-none flex-wrap gap-x-4 gap-y-1 p-0" aria-label="Median time per stage">${legend}</ul>`;
}

export function renderPerformance(view: {
  range: PerformanceRange;
  data: Data | null;
  loading: boolean;
  error: string | null;
  repository?: string | null;
  repositories?: string[];
}): string {
  const picked = view.repository ?? null;
  const names = [...new Set([...(view.repositories ?? []), ...(picked ? [picked] : [])])].sort();
  const repositoryPicker = `<label class="sr-only" for="perf-repository">Repository</label><select id="perf-repository" class="min-h-11" data-perf-repository${view.loading ? " disabled" : ""}><option value=""${picked ? "" : " selected"}>All repositories</option>${names.map((name) => `<option value="${esc(name)}"${name === picked ? " selected" : ""}>${esc(name)}</option>`).join("")}</select>`;
  const picker = `<nav class="segmented" aria-label="Time range">${Object.entries(
    PERFORMANCE_RANGES,
  )
    .map(
      ([id, range]) =>
        `<button class="btn${view.range === id ? " on" : ""}" type="button" data-perf-range="${id}" aria-pressed="${view.range === id}"${view.loading ? " disabled" : ""}>${range.label}</button>`,
    )
    .join("")}</nav>`;
  const head = `<div class="between"><div class="row">${picker}${repositoryPicker}</div>${view.loading ? '<span class="sub" role="status">Loading…</span>' : ""}</div>`;
  if (view.error)
    return `${head}<p class="settings-message err" role="alert">${esc(view.error)}</p>`;
  const data = view.data;
  if (!data) return head;
  if (
    data.series.every((entry) => entry.points.length === 0) &&
    data.items.length === 0 &&
    data.checks.length === 0
  )
    return `${head}<p class="sub" role="status" data-perf-empty>No data in this range</p>`;
  const stepMs = PERFORMANCE_RANGES[view.range].step === "minute" ? 60_000 : 3_600_000;
  const lag = combine(named(data, "process.event_loop_lag"));
  const cpu = timeline(named(data, "process.cpu_percent"), (point) => point.gauge);
  const api = combine(
    named(data, "http.request").filter((entry) => entry.labels.route?.startsWith("/api/")),
  );
  const merged = data.items.filter((item) => item.state === "merged");
  const mergeMs = median(merged.map((item) => sum(Object.values(item.stagesMs))));
  const tiles = `<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">${tile("Event-loop lag p95", lag.p95, formatMs, lagLevel)}${tile("Process CPU", cpu.length ? sum(cpu.map((point) => point.v)) / cpu.length : null, percent, cpuLevel)}${tile("Dashboard API p95", api.p95, formatMs, apiLevel)}${tile("Delegation to merge, median", mergeMs, formatMs, mergeLevel)}</div>`;

  const medians = STAGES.map((stage) => ({
    ...stage,
    ms: median(merged.map((item) => item.stagesMs[stage.key])) ?? 0,
  }));
  const slowChecks = data.checks
    .slice(0, 10)
    .map((check) => [
      `<span class="mono">${esc(check.checkId)}</span>`,
      `<span class="mono">${check.runs}</span>`,
      `<span class="mono">${check.failures ?? 0} of ${check.runs}</span>`,
      `<span class="mono">${formatMs(check.medianMs)}</span>`,
      bar(check.medianMs, data.checks[0]!.medianMs, null),
      `<span class="mono">${formatMs(check.p95Ms)}</span>`,
      `<span class="mono">${check.timeouts}</span>`,
    ]);
  const slowItems = data.items
    .map((item) => ({ item, ms: sum(Object.values(item.stagesMs)) }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 10)
    .map(({ item, ms }) => [
      `<a href="${esc(routeHref({ view: "issues", id: item.itemId }))}">${esc(item.identifier ?? item.itemId)}</a> ${esc(item.title ?? "")}`,
      `<span class="mono">${formatMs(ms)}</span>`,
    ]);
  const work = section(
    "work",
    picked ? `Where an issue's time goes in ${esc(picked)}` : "Where an issue's time goes",
    `<h3>Median per stage, merged issues</h3>${merged.length ? stageBar(medians) : EMPTY}${table(
      ["Stage", "Median"],
      medians.map((stage) => [stage.label, `<span class="mono">${formatMs(stage.ms)}</span>`]),
    )}<h3>Slowest Closeout checks</h3>${slowChecks.length ? table(["Check", "Runs", "Failures", "Median", "", "p95", "Timeouts"], slowChecks) : EMPTY}<h3>Slowest issues</h3>${slowItems.length ? table(["Issue", "Total"], slowItems) : EMPTY}`,
  );

  const operations = [...groups(named(data, "host.operation"), "operation")]
    .map(([name, entries]) => ({ name, ...combine(entries) }))
    .sort((a, b) => b.max - a.max)
    .slice(0, 10)
    .map((row) => [
      `<span class="mono">${esc(row.name)}</span>`,
      `<span class="mono">${formatMs(row.max)}</span>`,
      `<span class="mono">${row.count}</span>`,
    ]);
  const memory = timeline(named(data, "process.rss_bytes"), (point) => point.gauge);
  const responsiveness = section(
    "responsiveness",
    "Responsiveness",
    `<p class="sub">Lag p95 ${lag.p95 === null ? "—" : formatMs(lag.p95)}, max ${formatMs(lag.max)}.</p>${lineChart(
      "Event-loop lag p95",
      timeline(named(data, "process.event_loop_lag"), (point) => point.p95),
      data,
      formatMs,
      100,
    )}${lineChart("Process CPU", cpu, data, percent)}${lineChart("Memory (RSS)", memory, data, megabytes)}<h3>What blocked the loop longest</h3>${operations.length ? table(["Operation", "Longest", "Times"], operations) : EMPTY}`,
    picked !== null,
  );

  const queueRows = (["job", "outbox"] as const).flatMap((kind) => {
    const label = kind === "job" ? "queue" : "kind";
    const depth = groups(named(data, `${kind}.depth`), label);
    const oldest = groups(named(data, `${kind}.oldest_age_ms`), label);
    const waits = groups(named(data, `${kind}.wait`), label);
    return [...new Set([...depth.keys(), ...waits.keys()])].sort().map((name) => {
      const waiting = latestGauge(depth.get(name) ?? [], data, stepMs);
      const age = waiting > 0 ? latestGauge(oldest.get(name) ?? [], data, stepMs) : 0;
      const p95 = combine(waits.get(name) ?? []).p95;
      return [
        `<span class="mono">${kind === "job" ? "Job" : "Outbox"}: ${esc(name)}</span>`,
        `<span class="mono">${waiting}</span>`,
        `<span class="mono">${waiting > 0 ? formatMs(age) : "—"}</span>`,
        `<span class="mono">${p95 === null ? "—" : formatMs(p95)}</span>`,
        status(p95 === null ? null : waitLevel(p95)),
      ];
    });
  });
  const queues = section(
    "queues",
    "Queues",
    queueRows.length
      ? table(["Queue", "Waiting now", "Oldest", "Wait p95", "State"], queueRows)
      : EMPTY,
    picked !== null,
  );

  const remaining = (name: string) => {
    const points = timeline(named(data, name), (point) => point.gauge);
    return points.length ? String(Math.round(points.at(-1)!.v)) : "—";
  };
  const callHead = ["Caller", "Calls", "p95", "", "Errors"];
  const linear = callRows(named(data, "linear.call"), "caller");
  const github = callRows(named(data, "github.call"), "caller");
  const routes = callRows(named(data, "http.request"), "route");
  const services = section(
    "services",
    "Linear, GitHub and the dashboard",
    `<h3>Linear</h3><p class="sub">Rate limit left: <span class="mono">${remaining("linear.rate_remaining")}</span></p>${linear.length ? table(callHead, linear) : EMPTY}<h3>GitHub</h3><p class="sub">Rate limit left: <span class="mono">${remaining("github.rate_remaining")}</span></p>${github.length ? table(callHead, github) : EMPTY}<h3>Dashboard routes</h3>${routes.length ? table(["Route", "Requests", "p95", "", "Errors"], routes) : EMPTY}`,
    picked !== null,
  );
  const byRepository = picked ? "" : repositoryTable(data.repositories ?? []);
  return `${head}${tiles}${byRepository}${work}${responsiveness}${queues}${services}`;
}

export function createPerformance() {
  let root: HTMLElement | null = null;
  let engine: string | null = null;
  let range: PerformanceRange = "24h";
  let data: Data | null = null;
  let loading = false;
  let error: string | null = null;
  let generation = 0;
  let repository: string | null = null;
  const known = new Set<string>();

  const paint = () => {
    if (root)
      renderMarkup(
        root,
        renderPerformance({ range, data, loading, error, repository, repositories: [...known] }),
      );
  };
  const get = async <T>(path: string): Promise<T> => {
    const response = await fetch(new URL(path, engine!), {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status}).`);
    return body as T;
  };
  const load = async () => {
    if (!engine) return;
    const started = ++generation;
    const to = Date.now();
    const { ms, step } = PERFORMANCE_RANGES[range];
    const window = `from=${to - ms}&to=${to}`;
    loading = true;
    error = null;
    paint();
    try {
      const [metrics, stages] = await Promise.all([
        get<{ from: number; to: number; series: Series[] }>(
          `/api/metrics?names=${NAMES.join(",")}&step=${step}&${window}`,
        ),
        get<{ items: StageItem[]; checks: Check[]; repositories?: Repository[] }>(
          `/api/metrics/stages?${window}${repository ? `&repository=${encodeURIComponent(repository)}` : ""}`,
        ),
      ]);
      if (started !== generation) return;
      data = {
        from: metrics.from,
        to: metrics.to,
        series: metrics.series,
        items: stages.items,
        checks: stages.checks,
        repositories: stages.repositories ?? [],
      };
      for (const row of data.repositories ?? []) known.add(row.repository);
    } catch (cause) {
      if (started !== generation) return;
      error = cause instanceof Error ? cause.message : "Metrics could not be read.";
    }
    loading = false;
    paint();
  };
  const pick = (next: string | null) => {
    if (next === repository) return;
    repository = next;
    const url = new URL(window.location.href);
    if (next) url.searchParams.set("repository", next);
    else url.searchParams.delete("repository");
    window.history.replaceState(window.history.state, "", url);
    void load();
  };
  const change = (event: Event) => {
    const target = event.target as HTMLSelectElement;
    if (target.matches?.("select[data-perf-repository]")) pick(target.value || null);
  };
  const click = (event: Event) => {
    const row = (event.target as Element).closest<HTMLElement>("[data-perf-pick]")?.dataset
      .perfPick;
    if (row) return pick(row);
    const choice = (event.target as Element).closest<HTMLElement>("[data-perf-range]")?.dataset
      .perfRange;
    if (!choice || !(choice in PERFORMANCE_RANGES) || choice === range) return;
    range = choice as PerformanceRange;
    void load();
  };
  return {
    mount(next: HTMLElement, nextEngine: string | null) {
      if (root === next && engine === nextEngine) return;
      root?.removeEventListener("click", click);
      root?.removeEventListener("change", change);
      root = next;
      engine = nextEngine;
      data = null;
      repository = new URL(window.location.href).searchParams.get("repository") || null;
      root.addEventListener("click", click);
      root.addEventListener("change", change);
      if (engine) void load();
      else paint();
    },
  };
}
