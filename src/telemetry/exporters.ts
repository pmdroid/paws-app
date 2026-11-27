import type { LogRecordExporter } from "@opentelemetry/sdk-logs";
import { AggregationTemporality, type PushMetricExporter } from "@opentelemetry/sdk-metrics";
import type { SpanExporter } from "@opentelemetry/sdk-trace";
import type { TelemetryProtocol } from "./settings";

export type ExporterConfig = {
  url: string;
  headers: Record<string, string>;
  timeoutMillis: number;
  temporality: "delta" | "cumulative";
};

export type ExporterSet = {
  metrics(config: ExporterConfig): PushMetricExporter;
  logs(config: ExporterConfig): LogRecordExporter;
  traces(config: ExporterConfig): SpanExporter;
};

export type ExporterLoaders = Record<TelemetryProtocol, () => Promise<ExporterSet>>;

const temporality = (config: ExporterConfig) =>
  config.temporality === "delta" ? AggregationTemporality.DELTA : AggregationTemporality.CUMULATIVE;

const http = (config: ExporterConfig, signal: string) => ({
  url: `${config.url}/v1/${signal}`,
  headers: config.headers,
  timeoutMillis: config.timeoutMillis,
});

type HttpModules = [
  { OTLPMetricExporter: new (options: object) => PushMetricExporter },
  { OTLPLogExporter: new (options: object) => LogRecordExporter },
  { OTLPTraceExporter: new (options: object) => SpanExporter },
];

const httpSet = ([metrics, logs, traces]: HttpModules): ExporterSet => ({
  metrics: (config) =>
    new metrics.OTLPMetricExporter({
      ...http(config, "metrics"),
      temporalityPreference: temporality(config),
    }),
  logs: (config) => new logs.OTLPLogExporter(http(config, "logs")),
  traces: (config) => new traces.OTLPTraceExporter(http(config, "traces")),
});

export const OTLP_EXPORTERS: ExporterLoaders = {
  "http/protobuf": async () =>
    httpSet(
      await Promise.all([
        import("@opentelemetry/exporter-metrics-otlp-proto"),
        import("@opentelemetry/exporter-logs-otlp-proto"),
        import("@opentelemetry/exporter-trace-otlp-proto"),
      ]),
    ),
  "http/json": async () =>
    httpSet(
      await Promise.all([
        import("@opentelemetry/exporter-metrics-otlp-http"),
        import("@opentelemetry/exporter-logs-otlp-http"),
        import("@opentelemetry/exporter-trace-otlp-http"),
      ]),
    ),
  async grpc() {
    const [grpc, metrics, logs, traces] = await Promise.all([
      import("@grpc/grpc-js"),
      import("@opentelemetry/exporter-metrics-otlp-grpc"),
      import("@opentelemetry/exporter-logs-otlp-grpc"),
      import("@opentelemetry/exporter-trace-otlp-grpc"),
    ]);
    const channel = (config: ExporterConfig) => {
      const metadata = new grpc.Metadata();
      for (const [name, value] of Object.entries(config.headers)) metadata.set(name, value);
      return {
        url: config.url,
        metadata,
        timeoutMillis: config.timeoutMillis,
        credentials: config.url.startsWith("https:")
          ? grpc.credentials.createSsl()
          : grpc.credentials.createInsecure(),
      };
    };
    return {
      metrics: (config) =>
        new metrics.OTLPMetricExporter({
          ...channel(config),
          temporalityPreference: temporality(config),
        }),
      logs: (config) => new logs.OTLPLogExporter(channel(config)),
      traces: (config) => new traces.OTLPTraceExporter(channel(config)),
    };
  },
};
