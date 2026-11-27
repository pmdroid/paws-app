import { expect, test } from "bun:test";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { AggregationTemporality, InMemoryMetricExporter } from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import {
  DEFAULT_TELEMETRY_SETTINGS,
  TelemetrySettingsError,
  createTelemetry,
  parseTelemetrySettings,
  type ExporterConfig,
  type ExporterLoaders,
  type ExporterSet,
  type TelemetryProtocol,
  type TelemetrySettings,
  type TelemetrySignal,
} from ".";

function fakes(fail?: ExportResult) {
  const made: { protocol: TelemetryProtocol; signal: string; config: ExporterConfig }[] = [];
  const memory = {
    metrics: new InMemoryMetricExporter(AggregationTemporality.DELTA),
    logs: new InMemoryLogRecordExporter(),
    traces: new InMemorySpanExporter(),
  };
  const failing = <T extends object>(exporter: T): T =>
    fail === undefined
      ? exporter
      : Object.assign(Object.create(exporter) as T, {
          export: (_items: unknown, done: (result: ExportResult) => void) => done(fail),
        });
  const set = (protocol: TelemetryProtocol): ExporterSet => ({
    metrics: (config) => (
      made.push({ protocol, signal: "metrics", config }),
      failing(memory.metrics)
    ),
    logs: (config) => (made.push({ protocol, signal: "logs", config }), failing(memory.logs)),
    traces: (config) => (made.push({ protocol, signal: "traces", config }), failing(memory.traces)),
  });
  const loaders: ExporterLoaders = {
    "http/protobuf": async () => set("http/protobuf"),
    "http/json": async () => set("http/json"),
    grpc: async () => set("grpc"),
  };
  return { made, memory, loaders };
}

const on = (patch: Partial<TelemetrySettings> = {}): TelemetrySettings => ({
  ...parseTelemetrySettings({ enabled: true, endpoint: "https://otel.example.com/" }),
  ...patch,
});

function telemetry(loaders: ExporterLoaders) {
  const failed: TelemetrySignal[] = [];
  const handle = createTelemetry({
    version: "git:abc",
    instanceId: "paws.example.com",
    exporters: loaders,
    countFailure: (signal) => failed.push(signal),
  });
  return { handle, failed };
}

test("off by default: the emitters are no-ops and nothing is built or sent", async () => {
  const { made, memory, loaders } = fakes();
  const { handle } = telemetry(loaders);
  await handle.apply(DEFAULT_TELEMETRY_SETTINGS, "secret");
  handle.metrics.createCounter("x").add(1);
  handle.logs.emit({ body: "x" });
  handle.traces.startSpan("x").end();
  await handle.flush();
  expect(made).toEqual([]);
  expect(memory.logs.getFinishedLogRecords()).toEqual([]);
  expect(handle.status()).toEqual({
    error: null,
    metrics: { lastExportAt: null, failuresLastHour: 0 },
    logs: { lastExportAt: null, failuresLastHour: 0 },
    traces: { lastExportAt: null, failuresLastHour: 0 },
  });
});

test("defaults match the approved settings and bad values are refused", () => {
  expect(DEFAULT_TELEMETRY_SETTINGS).toMatchObject({
    enabled: false,
    protocol: "http/protobuf",
    headerName: "Authorization",
    metrics: { enabled: true, intervalMinutes: 1, temporality: "delta", durations: "histogram" },
    alerts: { enabled: true, minSeverity: "warning", sendCleared: true },
    items: { enabled: true, scope: "all", includeRepositoryAndRunner: true },
    traces: { enabled: false, which: "all", detail: "stages_and_checks", slowHours: 4 },
  });
  for (const body of [
    { protocol: "udp" },
    { metrics: { intervalMinutes: 2 } },
    { traces: { which: "some" } },
    { alerts: { minSeverity: "loud" } },
    { endpoint: "http://otel.example.com" },
    { endpoint: "ftp://localhost" },
    { enabled: true },
    { headerName: "bad name" },
  ])
    expect(() => parseTelemetrySettings(body)).toThrow(TelemetrySettingsError);
  expect(parseTelemetrySettings({ endpoint: "http://localhost:4318/" }).endpoint).toBe(
    "http://localhost:4318",
  );
});

test("each protocol picks its own exporter and the check reports success", async () => {
  for (const protocol of ["http/protobuf", "http/json", "grpc"] as const) {
    const { made, memory, loaders } = fakes();
    const { handle } = telemetry(loaders);
    expect(await handle.check(on({ protocol }), "Bearer t")).toEqual({ ok: true });
    expect(made).toEqual([
      {
        protocol,
        signal: "metrics",
        config: {
          url: "https://otel.example.com",
          headers: { Authorization: "Bearer t" },
          timeoutMillis: 10_000,
          temporality: "delta",
        },
      },
    ]);
    const exported = memory.metrics.getMetrics()[0]!;
    expect(exported.resource.attributes).toMatchObject({
      "service.name": "paws",
      "service.version": "git:abc",
      "service.instance.id": "paws.example.com",
    });
    expect(exported.scopeMetrics[0]!.metrics[0]!.descriptor.name).toBe("paws.telemetry.check");
  }
});

test("a failing transport counts the failure and never throws to the caller", async () => {
  const error = Object.assign(new Error("Unauthorized"), { code: 401 });
  const { loaders } = fakes({ code: ExportResultCode.FAILED, error });
  const { handle, failed } = telemetry(loaders);
  expect(await handle.check(on(), null)).toEqual({ ok: false, status: 401, error: "Unauthorized" });
  await handle.apply(on({ traces: { ...on().traces, enabled: true } }), null);
  handle.logs.emit({ body: "alert" });
  handle.traces.startSpan("item").end();
  await handle.flush();
  expect(failed.sort()).toEqual(["logs", "traces"]);
  expect(handle.status().logs.failuresLastHour).toBe(1);
  expect(handle.status().traces.failuresLastHour).toBe(1);
});

test("turning export off drops queued records and an exporter that cannot load is reported", async () => {
  const { memory, loaders } = fakes();
  const { handle } = telemetry(loaders);
  await handle.apply(on(), null);
  handle.logs.emit({ body: "kept" });
  await handle.flush();
  expect(memory.logs.getFinishedLogRecords().map((r) => r.body)).toEqual(["kept"]);
  expect(handle.status().logs.lastExportAt).not.toBeNull();
  handle.logs.emit({ body: "dropped" });
  await handle.apply(on({ enabled: false }), null);
  handle.logs.emit({ body: "after" });
  await handle.flush();
  expect(memory.logs.getFinishedLogRecords().map((r) => r.body)).toEqual(["kept"]);
  const broken = { ...fakes().loaders, grpc: () => Promise.reject(new Error("no grpc")) };
  const grpc = telemetry(broken).handle;
  await grpc.apply(on({ protocol: "grpc" }), null);
  expect(grpc.status().error).toBe("The grpc exporter could not load: no grpc");
  expect(await grpc.check(on({ protocol: "grpc" }), null)).toMatchObject({ ok: false });
  expect(await grpc.check(on({ protocol: "http/json" }), null)).toEqual({ ok: true });
});
