import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { ExportResultCode, hrTimeToMilliseconds, type ExportResult } from "@opentelemetry/core";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace";
import type { Db, Q } from "../src/db";
import {
  createTelemetry,
  exportItemTraces,
  parseTelemetrySettings,
  saveTelemetrySettings,
  type ExporterSet,
  type TelemetrySettings,
} from "../src/telemetry";
import { insertWorkItemSteps } from "./pglite-fixtures";
import { tempStore } from "./pglite";

const MINUTE = 60_000;
const START = Date.UTC(2026, 10, 25, 8, 0, 0);
const at = (minutes: number) => START + minutes * MINUTE;
let closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.map((close) => close()));
  closers = [];
});

async function setup(traces: Partial<TelemetrySettings["traces"]> = {}) {
  const opened = await tempStore();
  const memory = new InMemorySpanExporter();
  const delivery = { failing: false, loading: Promise.resolve() };
  const set = {
    traces: () => ({
      export: (spans: ReadableSpan[], done: (result: ExportResult) => void) =>
        delivery.failing
          ? done({ code: ExportResultCode.FAILED, error: new Error("503") })
          : memory.export(spans, done),
      shutdown: async () => {},
      forceFlush: async () => {},
    }),
  } as unknown as ExporterSet;
  const telemetry = createTelemetry({
    version: "git:abc",
    instanceId: "paws.example.com",
    exporters: {
      "http/protobuf": async () => (await delivery.loading, set),
      "http/json": async () => set,
      grpc: async () => set,
    },
  });
  const off = { enabled: false };
  const settings = parseTelemetrySettings({
    enabled: true,
    endpoint: "https://otel.example.com",
    metrics: off,
    alerts: off,
    items: off,
    traces: { enabled: true, ...traces },
  });
  await telemetry.apply(settings, null);
  closers.push(async () => {
    await telemetry.shutdown();
    await opened.close();
  });
  return { db: opened.db, memory, telemetry, settings, delivery };
}

function seedItem(db: Db, id: string, states: [string, number][]) {
  return db.run(function* (q: Q) {
    yield* insertWorkItemSteps(q, id, START);
    let from = "queued";
    for (const [index, [to, minutes]] of states.entries()) {
      yield* q.exec(
        q.orm.insert(q.t.workItemEvent).values({
          itemId: id,
          version: index + 1,
          at: at(minutes),
          fromState: from,
          toState: to,
          event: to,
        }),
      );
      from = to;
    }
    yield* q.exec(q.orm.update(q.t.workItem).set({ state: from }).where(eq(q.t.workItem.id, id)));
  });
}

function seedRun(db: Db, itemId: string, id: string, from: number, to: number) {
  return db.run((q) =>
    q.exec(
      q.orm.insert(q.t.run).values({
        id,
        itemId,
        kind: "work",
        agent: "claude",
        status: "ended",
        createdAt: at(from),
        updatedAt: at(to),
      }),
    ),
  );
}

const spansOf = (memory: InMemorySpanExporter) =>
  memory.getFinishedSpans().map((span) => ({
    name: span.name,
    start: hrTimeToMilliseconds(span.startTime),
    end: hrTimeToMilliseconds(span.endTime),
    traceId: span.spanContext().traceId,
    parent: span.parentSpanContext?.spanId ?? null,
    attributes: span.attributes,
  }));

test("a merged item's trace has one span per stored stage, run, check and question", async () => {
  const { db, memory, telemetry } = await setup();
  await seedItem(db, "item-a", [
    ["running", 10],
    ["awaiting_input", 40],
    ["running", 70],
    ["verifying", 100],
    ["merge_queue", 120],
    ["merged", 130],
  ]);
  await seedRun(db, "item-a", "run-1", 10, 40);
  await seedRun(db, "item-a", "run-2", 70, 100);
  await db.run(function* (q: Q) {
    yield* q.exec(
      q.orm.insert(q.t.closeoutProgress).values({
        id: "progress",
        itemId: "item-a",
        taskId: "task",
        base: "main",
        head: "abc",
        policyDigest: "digest",
        startedAt: at(100),
        updatedAt: at(120),
      }),
    );
    yield* q.exec(
      q.orm.insert(q.t.closeoutStep).values({
        progressId: "progress",
        stepId: "test",
        kind: "command",
        state: "passed",
        command: "bun test",
        attempt: 1,
        ordinal: 0,
        startedAt: at(100),
        finishedAt: at(120),
      }),
    );
  });

  expect(await exportItemTraces(db, telemetry, START)).toBe(1);
  const spans = spansOf(memory);
  const root = memory.getFinishedSpans().find((span) => span.name === "paws.item")!;
  const traceId = createHash("sha256").update("item-a").digest("hex").slice(0, 32);
  expect(spans.every((span) => span.traceId === traceId)).toBe(true);
  expect(
    spans
      .filter((span) => span.name !== "paws.item")
      .every((span) => span.parent === root.spanContext().spanId),
  ).toBe(true);
  expect(
    spans.map(({ name, start, end }) => [name, (start - START) / MINUTE, (end - START) / MINUTE]),
  ).toEqual([
    ["paws.queue", 0, 10],
    ["paws.run", 10, 40],
    ["paws.question", 40, 70],
    ["paws.run", 70, 100],
    ["paws.closeout.check", 100, 120],
    ["paws.merge_queue", 120, 130],
    ["paws.item", 0, 130],
  ]);
  expect(root.attributes).toEqual({
    "paws.item.id": "item-a",
    "paws.item.identifier": "item-a",
    "paws.item.state": "merged",
  });

  memory.reset();
  expect(await exportItemTraces(db, telemetry, at(200))).toBe(0);
  await telemetry.flush();
  expect(memory.getFinishedSpans()).toEqual([]);
});

test("an item with 600 stages is capped at 500 spans plus a summary span", async () => {
  const { db, memory, telemetry } = await setup();
  await seedItem(db, "item-a", [
    ["running", 0],
    ["merged", 700],
  ]);
  for (let index = 0; index < 600; index++)
    await seedRun(db, "item-a", `run-${String(index).padStart(3, "0")}`, index, index + 1);

  await exportItemTraces(db, telemetry, START);
  const spans = spansOf(memory);
  expect(spans).toHaveLength(501);
  expect(spans.filter((span) => span.name === "paws.run")).toHaveLength(499);
  const more = spans.find((span) => span.name === "paws.more")!;
  expect(more.attributes).toEqual({ "paws.spans.omitted": 101 });
  expect([more.start, more.end]).toEqual([at(499), at(600)]);
});

test("only items that end while traces are on are sent, from the moment they were turned on", async () => {
  const { db, memory, telemetry, settings } = await setup();
  const off = { ...settings, traces: { ...settings.traces, enabled: false } };
  await seedItem(db, "item-a", [["merged", 10]]);
  await saveTelemetrySettings(db, settings, at(20));
  await seedItem(db, "item-b", [["merged", 25]]);
  expect(await exportItemTraces(db, telemetry, at(30))).toBe(1);

  await saveTelemetrySettings(db, off, at(40));
  await seedItem(db, "item-c", [["merged", 45]]);
  await saveTelemetrySettings(db, settings, at(50));
  await seedItem(db, "item-d", [["failed", 55]]);
  expect(await exportItemTraces(db, telemetry, at(60))).toBe(1);
  const roots = spansOf(memory).filter((span) => span.name === "paws.item");
  expect(roots.map((span) => span.attributes["paws.item.id"])).toEqual(["item-b", "item-d"]);
});

test("a trace the endpoint refuses is not marked exported and is sent on a later run", async () => {
  const { db, memory, telemetry, settings, delivery } = await setup();
  await seedItem(db, "item-a", [["merged", 10]]);
  delivery.failing = true;
  expect(await exportItemTraces(db, telemetry, START)).toBe(0);
  delivery.failing = false;
  const loaded = Promise.withResolvers<void>();
  delivery.loading = loaded.promise;
  const applying = telemetry.apply(settings, null);
  expect(await exportItemTraces(db, telemetry, at(15))).toBe(0);
  loaded.resolve();
  await applying;
  expect(await exportItemTraces(db, telemetry, at(20))).toBe(1);
  expect(spansOf(memory).filter((span) => span.name === "paws.item")).toHaveLength(1);
});

test("failed_or_slow sends failures and slow items, and stages leaves out checks", async () => {
  const { db, memory, telemetry } = await setup({
    which: "failed_or_slow",
    detail: "stages",
    slowHours: 4,
  });
  await seedItem(db, "fast", [["merged", 60]]);
  await seedItem(db, "slow", [["completed", 5 * 60]]);
  await seedItem(db, "cancelled", [["cancelled", 30]]);
  expect(await exportItemTraces(db, telemetry, START)).toBe(2);
  const roots = spansOf(memory).filter((span) => span.name === "paws.item");
  expect(roots.map((span) => span.attributes["paws.item.id"]).sort()).toEqual([
    "cancelled",
    "slow",
  ]);
  expect(await exportItemTraces(db, telemetry, at(400))).toBe(0);
});
