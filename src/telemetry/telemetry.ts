import {
  createNoopLogger,
  createNoopMeter,
  trace,
  type Logger,
  type Meter,
  type Span,
  type SpanOptions,
  type Tracer,
} from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, RandomIdGenerator, TracerProvider } from "@opentelemetry/sdk-trace";
import type { MetricMinuteRow } from "../db";
import { journal, journalCaught } from "../journal";
import { incrementCounter } from "../metrics";
import { OTLP_EXPORTERS, type ExporterConfig, type ExporterLoaders } from "./exporters";
import { createMinuteProducer, type MinuteTotals } from "./minutes";
import { DEFAULT_TELEMETRY_SETTINGS, type TelemetrySettings } from "./settings";

export type TelemetrySignal = "metrics" | "logs" | "traces";
const SIGNALS: readonly TelemetrySignal[] = ["metrics", "logs", "traces"];
const EXPORT_TIMEOUT_MS = 10_000;
const MAX_QUEUE = 2048;
const HOUR_MS = 3_600_000;
const JOURNAL_EVERY_MS = 60_000;

export type TelemetryCheck = { ok: true } | { ok: false; status: number | null; error: string };
export type TelemetryStatus = {
  error: string | null;
} & Record<TelemetrySignal, { lastExportAt: number | null; failuresLastHour: number }>;

export type Telemetry = {
  readonly metrics: Meter;
  readonly logs: Logger;
  readonly traces: Tracer;
  settings(): TelemetrySettings;
  exportMetricMinutes(rows: readonly MetricMinuteRow[]): void;
  startTrace(name: string, traceId: string, options: SpanOptions): Span;
  apply(settings: TelemetrySettings, headerValue: string | null): Promise<void>;
  check(settings: TelemetrySettings, headerValue: string | null): Promise<TelemetryCheck>;
  status(): TelemetryStatus;
  flush(signal?: TelemetrySignal): Promise<boolean>;
  shutdown(): Promise<void>;
};

export type TelemetryOptions = {
  version: string;
  instanceId: string;
  exporters?: ExporterLoaders;
  countFailure?: (signal: TelemetrySignal) => void;
  now?: () => number;
};

type Exporter = { export(items: unknown, done: (result: ExportResult) => void): void };

function tracked<T extends object>(
  inner: T,
  onResult: (result: ExportResult) => void,
  closed: () => boolean,
): T {
  return new Proxy(inner, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (key !== "export") return typeof value === "function" ? value.bind(target) : value;
      return (items: unknown, done: (result: ExportResult) => void) => {
        if (closed())
          return done({ code: ExportResultCode.FAILED, error: new Error("Export is off.") });
        try {
          (target as unknown as Exporter).export(items, (result) => {
            onResult(result);
            done(result);
          });
        } catch (error) {
          const result = { code: ExportResultCode.FAILED, error: error as Error };
          onResult(result);
          done(result);
        }
      };
    },
  });
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Active = {
  settings: TelemetrySettings;
  meter: Meter;
  logger: Logger;
  tracer: Tracer;
  minutes(rows: readonly MetricMinuteRow[]): void;
  flush(signal?: TelemetrySignal): Promise<boolean>;
  close(): void;
};

export function createTelemetry(options: TelemetryOptions): Telemetry {
  const loaders = options.exporters ?? OTLP_EXPORTERS;
  const now = options.now ?? Date.now;
  const countFailure =
    options.countFailure ??
    ((signal: TelemetrySignal) => incrementCounter("telemetry.export_failed", { signal }));
  const lastExportAt: Record<TelemetrySignal, number | null> = {
    metrics: null,
    logs: null,
    traces: null,
  };
  const failures: Record<TelemetrySignal, number[]> = { metrics: [], logs: [], traces: [] };
  const journaledAt: Record<TelemetrySignal, number> = { metrics: 0, logs: 0, traces: 0 };
  const minuteTotals: MinuteTotals = new Map();
  let loadError: string | null = null;
  let generation = 0;
  let pinnedTraceId: string | null = null;
  const randomIds = new RandomIdGenerator();
  const idGenerator = {
    generateTraceId: () => pinnedTraceId ?? randomIds.generateTraceId(),
    generateSpanId: () => randomIds.generateSpanId(),
  };

  const off = (settings: TelemetrySettings): Active => ({
    settings,
    meter: createNoopMeter(),
    logger: createNoopLogger(),
    tracer: trace.getTracer("paws"),
    minutes() {},
    flush: async () => false,
    close() {},
  });
  let active = off(DEFAULT_TELEMETRY_SETTINGS);

  const prune = (signal: TelemetrySignal) => {
    const since = now() - HOUR_MS;
    failures[signal] = failures[signal].filter((at) => at > since).slice(-10_000);
  };
  const record = (signal: TelemetrySignal) => (result: ExportResult) => {
    if (result.code === ExportResultCode.SUCCESS) {
      lastExportAt[signal] = now();
      return;
    }
    failures[signal].push(now());
    prune(signal);
    countFailure(signal);
    if (now() - journaledAt[signal] < JOURNAL_EVERY_MS) return;
    journaledAt[signal] = now();
    journal(`OTLP ${signal} export failed: ${message(result.error ?? "unknown error")}`);
  };

  const resource = (settings: TelemetrySettings) =>
    resourceFromAttributes({
      "service.name": "paws",
      "service.version": options.version,
      "service.instance.id": options.instanceId,
      ...(settings.environment === "" ? {} : { "deployment.environment": settings.environment }),
    });
  const config = (settings: TelemetrySettings, headerValue: string | null): ExporterConfig => ({
    url: settings.endpoint,
    headers: headerValue ? { [settings.headerName]: headerValue } : {},
    timeoutMillis: EXPORT_TIMEOUT_MS,
    temporality: settings.metrics.temporality,
  });
  const load = async (settings: TelemetrySettings) => {
    try {
      return await loaders[settings.protocol]();
    } catch (error) {
      return `The ${settings.protocol} exporter could not load: ${message(error)}`;
    }
  };

  const build = (
    settings: TelemetrySettings,
    headerValue: string | null,
    set: Awaited<ReturnType<ExporterLoaders["grpc"]>>,
  ): Active => {
    let closed = false;
    const shut = () => closed;
    const exporterConfig = config(settings, headerValue);
    const res = resource(settings);
    const next = off(settings);
    const providers: {
      signal: TelemetrySignal;
      provider: { forceFlush(): Promise<void>; shutdown(): Promise<void> };
    }[] = [];
    if (settings.metrics.enabled) {
      const minutes = createMinuteProducer(
        settings.metrics,
        res,
        { name: "paws", version: options.version },
        minuteTotals,
      );
      const reader = new PeriodicExportingMetricReader({
        metricProducers: [minutes.producer],
        exporter: tracked(set.metrics(exporterConfig), record("metrics"), shut),
        exportIntervalMillis: settings.metrics.intervalMinutes * 60_000,
        exportTimeoutMillis: EXPORT_TIMEOUT_MS,
      });
      const provider = new MeterProvider({ resource: res, readers: [reader] });
      providers.push({ signal: "metrics", provider });
      next.meter = provider.getMeter("paws", options.version);
      next.minutes = (rows) => (closed ? undefined : minutes.add(rows));
    }
    if (settings.alerts.enabled || settings.items.enabled) {
      const exporter = tracked(set.logs(exporterConfig), record("logs"), shut);
      const provider = new LoggerProvider({
        resource: res,
        processors: [
          new BatchLogRecordProcessor({
            exporter,
            exportTimeoutMillis: EXPORT_TIMEOUT_MS,
            maxQueueSize: MAX_QUEUE,
          }),
        ],
      });
      providers.push({ signal: "logs", provider });
      next.logger = provider.getLogger("paws", options.version);
    }
    if (settings.traces.enabled) {
      const exporter = tracked(set.traces(exporterConfig), record("traces"), shut);
      const provider = new TracerProvider({
        resource: res,
        idGenerator,
        spanProcessors: [
          new BatchSpanProcessor({
            exporter,
            exportTimeoutMillis: EXPORT_TIMEOUT_MS,
            maxQueueSize: MAX_QUEUE,
          }),
        ],
      });
      providers.push({ signal: "traces", provider });
      next.tracer = provider.getTracer("paws", options.version);
    }
    next.flush = async (signal) => {
      const flushing = providers.filter((p) => signal === undefined || p.signal === signal);
      const results = await Promise.allSettled(flushing.map((p) => p.provider.forceFlush()));
      for (const result of results)
        if (result.status === "rejected") journalCaught(result.reason, "telemetry.flush", null);
      return flushing.length > 0 && results.every((result) => result.status === "fulfilled");
    };
    next.close = () => {
      closed = true;
      for (const { provider } of providers)
        provider.shutdown().catch((error) => journalCaught(error, "telemetry.close", null));
    };
    return next;
  };

  return {
    get metrics() {
      return active.meter;
    },
    get logs() {
      return active.logger;
    },
    get traces() {
      return active.tracer;
    },
    settings: () => active.settings,
    exportMetricMinutes(rows) {
      try {
        active.minutes(rows);
      } catch (error) {
        journalCaught(error, "telemetry.metrics", null);
      }
    },
    startTrace(name, traceId, spanOptions) {
      pinnedTraceId = traceId;
      try {
        return active.tracer.startSpan(name, { ...spanOptions, root: true });
      } finally {
        pinnedTraceId = null;
      }
    },
    async apply(settings, headerValue) {
      const mine = ++generation;
      active.close();
      active = off(settings);
      loadError = null;
      if (!settings.enabled) return;
      const set = await load(settings);
      if (mine !== generation) return;
      if (typeof set === "string") {
        loadError = set;
        return;
      }
      try {
        active = build(settings, headerValue, set);
      } catch (error) {
        loadError = `OTLP export could not start: ${message(error)}`;
      }
    },
    async check(settings, headerValue) {
      const set = await load(settings);
      if (typeof set === "string") return { ok: false, status: null, error: set };
      let result: ExportResult | undefined;
      try {
        const reader = new PeriodicExportingMetricReader({
          exporter: tracked(
            set.metrics(config(settings, headerValue)),
            (outcome) => (result = outcome),
            () => false,
          ),
          exportIntervalMillis: HOUR_MS,
          exportTimeoutMillis: EXPORT_TIMEOUT_MS,
        });
        const provider = new MeterProvider({ resource: resource(settings), readers: [reader] });
        provider.getMeter("paws", options.version).createCounter("paws.telemetry.check").add(1);
        await provider.shutdown();
      } catch (error) {
        result ??= { code: ExportResultCode.FAILED, error: error as Error };
      }
      if (result?.code === ExportResultCode.SUCCESS) return { ok: true };
      const code = (result?.error as { code?: unknown } | undefined)?.code;
      return {
        ok: false,
        status: typeof code === "number" ? code : null,
        error: message(result?.error ?? "No metric was exported."),
      };
    },
    status() {
      const signals = SIGNALS.map((signal) => {
        prune(signal);
        const entry = {
          lastExportAt: lastExportAt[signal],
          failuresLastHour: failures[signal].length,
        };
        return [signal, entry] as const;
      });
      return { error: loadError, ...Object.fromEntries(signals) } as TelemetryStatus;
    },
    flush: (signal) => active.flush(signal),
    async shutdown() {
      generation++;
      active.close();
      active = off(active.settings);
    },
  };
}
