import { statusClass, type MetricsRecorder } from "../metrics";

const TERMINAL = new Set(["refs", "ref", "branches", "contents", "compare", "labels", "tags"]);

export function githubOperation(path: string): string {
  const segments = (path.split("?")[0] ?? "").split("/").filter((segment) => segment !== "");
  const rest = segments[0] === "repos" ? segments.slice(3) : segments;
  const names: string[] = [];
  for (const segment of rest) {
    if (!/^[a-z][a-z_-]*$/.test(segment)) continue;
    names.push(segment);
    if (TERMINAL.has(segment) || names.length === 4) break;
  }
  return names.length === 0 ? (segments[0] ?? "root") : names.join(".");
}

export function observeGitHubCall(
  metrics: MetricsRecorder,
  caller: string,
  started: number,
  status: number | null,
  rateLimited: boolean,
): void {
  metrics.recordDuration(
    "github.call",
    { caller, status_class: statusClass(status) },
    performance.now() - started,
  );
  if (rateLimited) metrics.incrementCounter("github.rate_limited", { caller });
}

export function observeGitHubRemaining(metrics: MetricsRecorder, headers: Headers): void {
  const remaining = headers.get("x-ratelimit-remaining")?.trim() ?? "";
  if (/^\d+$/.test(remaining)) metrics.setGauge("github.rate_remaining", {}, Number(remaining));
}
