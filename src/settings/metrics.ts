import type { Db } from "../db";
import { journalCaught } from "../journal";
import { METRICS_RETENTION_MS, readMetricSeries, type MetricStep } from "../metrics";
import { isWorkspaceAdmin } from "../workspace";
import { json, localRequest } from "./handler";

export const METRICS_PATH = "/api/metrics";
const MAX_NAMES = 50;
const MAX_MINUTE_RANGE_MS = 24 * 60 * 60_000;

export type MetricsApiOptions = {
  store: Db;
  trustedOrigin?: string;
  role?: string;
  now?: number;
};

function instant(value: string | null, fallback: number): number | null {
  if (value === null || value === "") return fallback;
  const parsed = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function handleMetricsRequest(
  request: Request,
  options: MetricsApiOptions,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== METRICS_PATH) return null;
  if (!localRequest(request, options.trustedOrigin))
    return json({ error: "Metrics are only available on the local Paws origin" }, 403);
  if (options.role !== undefined && !isWorkspaceAdmin(options.role))
    return json({ error: "Only workspace admins can see metrics." }, 403);
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const params = url.searchParams;
  const names = [
    ...new Set((params.get("names") ?? "").split(",").map((name) => name.trim())),
  ].filter(Boolean);
  if (names.length === 0 || names.length > MAX_NAMES)
    return json({ error: `names must list 1 to ${MAX_NAMES} metric names.` }, 400);
  const step = (params.get("step") ?? "minute") as MetricStep;
  if (step !== "minute" && step !== "hour")
    return json({ error: "step must be minute or hour." }, 400);
  const now = options.now ?? Date.now();
  const to = instant(params.get("to"), now);
  const from = instant(params.get("from"), (to ?? now) - 60 * 60_000);
  if (from === null || to === null || from >= to)
    return json({ error: "from and to must be times with from before to." }, 400);
  if (to - from > (step === "hour" ? METRICS_RETENTION_MS : MAX_MINUTE_RANGE_MS))
    return json({ error: "That range is too long for this step." }, 400);
  try {
    return json({
      step,
      from,
      to,
      series: await readMetricSeries(options.store, { names, from, to, step }),
    });
  } catch (error) {
    journalCaught(error, "settings.metrics.read", null);
    return json({ error: "Metrics could not be read" }, 503);
  }
}
