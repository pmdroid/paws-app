import { afterEach, expect, test } from "bun:test";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { InMemoryLogRecordExporter, type ReadableLogRecord } from "@opentelemetry/sdk-logs";
import { exportAlerts } from "../src/alerts";
import {
  exportedAlertsSteps,
  insertMetricMinutesSteps,
  pendingAlertEventsSteps,
  type Db,
} from "../src/db";
import {
  createTelemetry,
  parseTelemetrySettings,
  saveTelemetrySettings,
  type ExporterSet,
  type Telemetry,
  type TelemetrySettings,
} from "../src/telemetry";
import { seed, withoutForeignKeys } from "./pglite-fixtures";
import { tempStore } from "./pglite";

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 10, 27, 6, 0, 0);
const HEARTBEAT = "runner_http_4xx:/v1/heartbeat";
let closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.map((close) => close()));
  closers = [];
});

async function store(): Promise<Db> {
  const opened = await tempStore();
  closers.push(opened.close);
  await withoutForeignKeys(opened.db);
  return opened.db;
}

const on = (alerts: Partial<TelemetrySettings["alerts"]> = {}): TelemetrySettings => {
  const settings = parseTelemetrySettings({ enabled: true, endpoint: "https://otel.example.com" });
  return {
    ...settings,
    metrics: { ...settings.metrics, enabled: false },
    alerts: { ...settings.alerts, ...alerts },
  };
};

async function telemetry(settings: TelemetrySettings | null = on()) {
  const memory = new InMemoryLogRecordExporter();
  const failing = { on: false };
  const logs = Object.assign(Object.create(memory) as InMemoryLogRecordExporter, {
    export: (items: ReadableLogRecord[], done: (result: ExportResult) => void) =>
      failing.on
        ? done({ code: ExportResultCode.FAILED, error: new Error("down") })
        : memory.export(items, done),
  });
  const set = async () => ({ logs: () => logs }) as unknown as ExporterSet;
  const handle = createTelemetry({
    version: "test",
    instanceId: "paws.test",
    exporters: { "http/protobuf": set, "http/json": set, grpc: set },
    countFailure: () => {},
  });
  closers.push(() => handle.shutdown());
  if (settings !== null) await handle.apply(settings, null);
  const sent = (attribute = "paws.alert.key") => {
    const found = memory.getFinishedLogRecords().filter((r) => r.attributes[attribute]);
    memory.reset();
    return found.map((r) => `${r.eventName} ${String(r.attributes[attribute])} ${r.severityText}`);
  };
  return { handle, sent, failing };
}

function runnerErrors(db: Db, route: string, minute = NOW - MINUTE) {
  const row = { name: "http.request", count: 30, sum: 30, max: 1, buckets: null, gauge: null };
  const labels = { route, method: "POST", status_class: "4xx" };
  return db.run((q) => insertMetricMinutesSteps(q, [{ ...row, minute, labels }]));
}

const stored = (db: Db) => db.run((q) => exportedAlertsSteps(q));
const queued = (db: Db) => db.run((q) => pendingAlertEventsSteps(q, 10));

test("a new alert raises once, stays quiet while unchanged and clears once when gone", async () => {
  const db = await store();
  const { handle, sent } = await telemetry();
  await runnerErrors(db, "/v1/heartbeat");
  await exportAlerts(db, handle, NOW);
  expect(sent()).toEqual([`paws.alert.raised ${HEARTBEAT} ERROR`]);
  await exportAlerts(db, handle, NOW + MINUTE);
  expect(sent()).toEqual([]);
  await exportAlerts(db, handle, NOW + 20 * MINUTE);
  expect(sent()).toEqual([`paws.alert.cleared ${HEARTBEAT} ERROR`]);
  expect(await stored(db)).toEqual([]);
});

test("a restart with stored state emits nothing new", async () => {
  const db = await store();
  await runnerErrors(db, "/v1/heartbeat");
  const before = await telemetry();
  await exportAlerts(db, before.handle, NOW);
  expect(before.sent()).toHaveLength(1);
  const after = await telemetry();
  await exportAlerts(db, after.handle, NOW + MINUTE);
  expect(after.sent()).toEqual([]);
});

test("export off records nothing, and turning it on raises every open alert", async () => {
  const db = await store();
  await runnerErrors(db, "/v1/heartbeat");
  await runnerErrors(db, "/v1/commands");
  const { handle, sent } = await telemetry(null);
  await exportAlerts(db, handle, NOW);
  expect(await stored(db)).toEqual([]);
  await handle.apply(on(), null);
  await exportAlerts(db, handle, NOW);
  expect(sent()).toHaveLength(2);
});

test("alerts below minSeverity are dropped, and sendCleared false still forgets a gone alert", async () => {
  const db = await store();
  await runnerErrors(db, "/v1/heartbeat");
  await seed(db, (q) =>
    q.orm.insert(q.t.outbox).values({
      ...{ target: "linear", op: "plan", idempotencyKey: "plan", payload: {}, status: "dead" },
      createdAt: NOW - 5 * MINUTE,
    }),
  );
  const { handle, sent } = await telemetry(on({ minSeverity: "critical", sendCleared: false }));
  await exportAlerts(db, handle, NOW);
  expect(sent()).toEqual([`paws.alert.raised ${HEARTBEAT} ERROR`]);
  await exportAlerts(db, handle, NOW + 20 * MINUTE);
  expect(sent()).toEqual([]);
  expect(await stored(db)).toEqual([]);
});

test("a run emits at most 200 records and the next run sends the rest", async () => {
  const db = await store();
  for (let route = 0; route < 201; route++) await runnerErrors(db, `/v1/r${route}`);
  const { handle, sent } = await telemetry();
  await exportAlerts(db, handle, NOW);
  expect(sent()).toHaveLength(200);
  await exportAlerts(db, handle, NOW);
  expect(sent()).toHaveLength(1);
});

test("every start and end seen while delivery fails is kept and sent in order", async () => {
  const db = await store();
  await runnerErrors(db, "/v1/heartbeat");
  const { handle, sent, failing } = await telemetry();
  failing.on = true;
  await exportAlerts(db, handle, NOW);
  await exportAlerts(db, handle, NOW + 20 * MINUTE);
  await runnerErrors(db, "/v1/heartbeat", NOW + 20 * MINUTE);
  failing.on = false;
  await exportAlerts(db, handle, NOW + 21 * MINUTE);
  expect(sent().map((line) => line.split(" ")[0])).toEqual([
    "paws.alert.raised",
    "paws.alert.cleared",
    "paws.alert.raised",
  ]);
  await exportAlerts(db, handle, NOW + 22 * MINUTE);
  expect(sent()).toEqual([]);
});

test("accepted trade-off: a crash after sendAlerts() and before the sent events are removed resends each record once with the same paws.alert.event_id", async () => {
  const db = await store();
  await runnerErrors(db, "/v1/heartbeat");
  const { handle, sent } = await telemetry();
  let crash = false;
  const crashing: Db = {
    ...db,
    run: (body) => (crash ? Promise.reject(new Error("crash")) : db.run(body)),
  };
  const sending: Telemetry = {
    ...handle,
    sendAlerts: async (records) => (crash = await handle.sendAlerts(records)),
  };
  await expect(exportAlerts(crashing, sending, NOW)).rejects.toThrow("crash");
  const first = sent("paws.alert.event_id");
  expect(first).toEqual([`paws.alert.raised paws.alert.raised:${HEARTBEAT}:${NOW - MINUTE} ERROR`]);
  await exportAlerts(db, handle, NOW + MINUTE);
  expect(sent("paws.alert.event_id")).toEqual(first);
  await exportAlerts(db, handle, NOW + 2 * MINUTE);
  expect(sent()).toEqual([]);
});

test("a full item-log queue neither drops nor falsely confirms alert records", async () => {
  const db = await store();
  await runnerErrors(db, "/v1/heartbeat");
  const { handle, sent, failing } = await telemetry();
  for (let i = 0; i < 3000; i++) handle.logs.emit({ eventName: "paws.item.transition" });
  failing.on = true;
  await exportAlerts(db, handle, NOW);
  failing.on = false;
  await handle.flush("logs");
  expect(await queued(db)).toHaveLength(1);
  await exportAlerts(db, handle, NOW + MINUTE);
  expect(sent()).toEqual([`paws.alert.raised ${HEARTBEAT} ERROR`]);
  expect(await queued(db)).toEqual([]);
});

test("turning export off during an in-flight run doesn't restore the stored set", async () => {
  const db = await store();
  await runnerErrors(db, "/v1/heartbeat");
  const { handle, sent } = await telemetry();
  await saveTelemetrySettings(db, on(), NOW);
  let calls = 0;
  const racing: Db = {
    ...db,
    run: async (body) => {
      if (++calls === 4) await saveTelemetrySettings(db, { ...on(), enabled: false }, NOW);
      return db.run(body);
    },
  };
  await exportAlerts(racing, handle, NOW);
  expect(sent()).toEqual([]);
  expect(await stored(db)).toEqual([]);
  expect(await queued(db)).toEqual([]);
});

test("turning export off and on between runs raises the open alerts again", async () => {
  const db = await store();
  await runnerErrors(db, "/v1/heartbeat");
  const { handle, sent } = await telemetry();
  await saveTelemetrySettings(db, on(), NOW);
  await exportAlerts(db, handle, NOW);
  expect(sent()).toHaveLength(1);
  await saveTelemetrySettings(db, { ...on(), enabled: false }, NOW);
  await saveTelemetrySettings(db, on(), NOW);
  await exportAlerts(db, handle, NOW + MINUTE);
  expect(sent()).toEqual([`paws.alert.raised ${HEARTBEAT} ERROR`]);
});
