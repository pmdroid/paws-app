import { storedRunnerName, type Db } from "../db";
import { setGauge as defaultSetGauge, type MetricLabels } from "../metrics";
import { RUNNER_HOST_METRICS_INTERVAL_MS, RunnerHostMetricsSchema } from "../runner-protocol";
import { readWebhookBody } from "../webhook-body";

const MAX_BODY_BYTES = 16 * 1024;

export type RunnerHostMetricsService = {
  fetch(request: Request, runnerId: string): Promise<Response | null>;
};

function gaugeName(field: string): string {
  return `runner.host.${field.replace(/[A-Z]/g, (part) => `_${part.toLowerCase()}`)}`;
}

export function createRunnerHostMetrics(options: {
  store: Db;
  setGauge?: (name: string, labels: MetricLabels, value: number) => void;
}): RunnerHostMetricsService {
  const setGauge = options.setGauge ?? defaultSetGauge;
  return {
    async fetch(request, runnerId) {
      if (new URL(request.url).pathname !== "/v1/host-metrics") return null;
      if (request.method !== "POST") return Response.json({ error: "Use POST." }, { status: 405 });
      const body = await readWebhookBody(request, MAX_BODY_BYTES);
      if (body instanceof Response) return body;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        return Response.json({ error: "Host metrics are not JSON." }, { status: 400 });
      }
      const report = RunnerHostMetricsSchema.safeParse(parsed);
      if (!report.success)
        return Response.json({ error: "Host metrics were rejected." }, { status: 400 });
      const runner = await storedRunnerName(options.store, runnerId);
      if (runner === null) return Response.json({ error: "Runner is unknown." }, { status: 403 });
      for (const [field, value] of Object.entries(report.data))
        if (field !== "at" && value !== undefined) setGauge(gaugeName(field), { runner }, value);
      return Response.json({ intervalMs: RUNNER_HOST_METRICS_INTERVAL_MS });
    },
  };
}
