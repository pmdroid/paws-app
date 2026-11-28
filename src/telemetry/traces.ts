import { createHash } from "node:crypto";
import { context, trace, type Attributes } from "@opentelemetry/api";
import {
  itemTraceRowsSteps,
  itemsToTraceSteps,
  markTraceExportedSteps,
  readSetting,
  updateSetting,
  type Db,
} from "../db";
import { TRACES_SINCE_KEY, type TelemetrySettings } from "./settings";
import type { Telemetry } from "./telemetry";

export const TRACES_EXPORT_JOB = "traces.export";
export const TRACES_EXPORT_EVERY_MS = 60_000;
const BATCH = 50;
const MAX_SPANS = 500;
const HOUR_MS = 3_600_000;
const STAGE_SPANS: Record<string, string> = {
  queued: "paws.queue",
  awaiting_input: "paws.question",
  merge_queue: "paws.merge_queue",
};

type Item = { id: string; identifier: string; state: string; createdAt: number; endedAt: number };
type Rows = ReturnType<typeof itemTraceRowsSteps> extends Generator<unknown, infer R> ? R : never;
type Child = { name: string; start: number; end: number; attributes: Attributes };

function wanted(settings: TelemetrySettings["traces"], item: Item, hash: string): boolean {
  if (settings.which === "all") return true;
  if (settings.which === "sample_25") return Number.parseInt(hash.slice(32, 40), 16) % 4 === 0;
  if (item.state === "failed" || item.state === "cancelled") return true;
  return item.endedAt - item.createdAt > settings.slowHours * HOUR_MS;
}

function children(item: Item, rows: Rows, withChecks: boolean): Child[] {
  const spans: Child[] = [];
  const stage = (state: string, start: number, end: number) => {
    const name = STAGE_SPANS[state];
    if (name !== undefined && end > start) spans.push({ name, start, end, attributes: {} });
  };
  let state = rows.events[0]?.fromState ?? item.state;
  let since = item.createdAt;
  for (const event of rows.events) {
    if (event.toState === state) continue;
    stage(state, since, event.at);
    state = event.toState;
    since = event.at;
  }
  stage(state, since, item.endedAt);
  for (const run of rows.runs)
    spans.push({
      name: "paws.run",
      start: run.startedAt,
      end: Math.max(run.startedAt, run.endedAt),
      attributes: { "paws.run.id": run.id },
    });
  if (withChecks)
    for (const check of rows.checks)
      spans.push({
        name: "paws.closeout.check",
        start: check.startedAt,
        end: Math.max(check.startedAt, check.endedAt),
        attributes: { "paws.closeout.check": check.checkId },
      });
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  if (spans.length < MAX_SPANS) return spans;
  const rest = spans.slice(MAX_SPANS - 1);
  return [
    ...spans.slice(0, MAX_SPANS - 1),
    {
      name: "paws.more",
      start: Math.min(...rest.map((span) => span.start)),
      end: Math.max(...rest.map((span) => span.end)),
      attributes: { "paws.spans.omitted": rest.length },
    },
  ];
}

function emit(telemetry: Telemetry, item: Item, traceId: string, spans: Child[]) {
  const tracer = telemetry.traces;
  const root = telemetry.startTrace("paws.item", traceId, {
    startTime: item.createdAt,
    attributes: {
      "paws.item.id": item.id,
      "paws.item.identifier": item.identifier,
      "paws.item.state": item.state,
    },
  });
  const parent = trace.setSpan(context.active(), root);
  for (const span of spans)
    tracer
      .startSpan(span.name, { startTime: span.start, attributes: span.attributes }, parent)
      .end(span.end);
  root.end(item.endedAt);
  return tracer;
}

export async function exportItemTraces(
  store: Db,
  telemetry: Telemetry,
  now = Date.now(),
): Promise<number> {
  const settings = telemetry.settings();
  if (!settings.enabled || !settings.traces.enabled || telemetry.status().error !== null) return 0;
  const stored = await readSetting(store, TRACES_SINCE_KEY);
  const since = stored ? Number(stored) : now;
  if (!stored) await updateSetting(store, TRACES_SINCE_KEY, () => String(now));
  const items = await store.run((q) => itemsToTraceSteps(q, { since, limit: BATCH }));
  let sent = 0;
  for (const item of items) {
    const hash = createHash("sha256").update(item.id).digest("hex");
    if (wanted(settings.traces, item, hash)) {
      const rows = await store.run((q) => itemTraceRowsSteps(q, item.id));
      const tracer = emit(
        telemetry,
        item,
        hash.slice(0, 32),
        children(item, rows, settings.traces.detail !== "stages"),
      );
      if (!(await telemetry.flush("traces")) || telemetry.traces !== tracer) break;
      sent += 1;
    }
    await store.run((q) =>
      markTraceExportedSteps(q, { itemId: item.id, endedAt: item.endedAt, exportedAt: now }),
    );
  }
  return sent;
}
