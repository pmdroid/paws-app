import { createHash, timingSafeEqual } from "node:crypto";
import type { EnvSource } from "../config";
import { runnerMetricsTargets, type Db } from "../db";
import { prometheusSdToken } from "./settings";

export const PROMETHEUS_RUNNERS_PATH = "/api/prometheus/runners";
const SEEN_WITHIN_MS = 10 * 60_000;

const digest = (value: string) => createHash("sha256").update(value).digest();

export async function handlePrometheusRunnersRequest(
  request: Request,
  options: { home: string; env: EnvSource; store: Db | undefined; now?: number },
): Promise<Response> {
  const expected = prometheusSdToken.read(options.home, options.env);
  if (expected === null || options.store === undefined)
    return Response.json({ error: "Not found" }, { status: 404 });
  if (request.method !== "GET")
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!timingSafeEqual(digest(given), digest(expected)))
    return Response.json(
      { error: "A valid bearer token is required." },
      { status: 401, headers: { "www-authenticate": "Bearer" } },
    );
  const runners = await runnerMetricsTargets(
    options.store,
    (options.now ?? Date.now()) - SEEN_WITHIN_MS,
  );
  return Response.json(
    runners.map((runner) => ({
      targets: [new URL(runner.metricsUrl).host],
      labels: { runner: runner.name, runner_id: runner.id },
    })),
    { headers: { "cache-control": "no-store" } },
  );
}
