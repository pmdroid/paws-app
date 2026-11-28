import { journalCaught } from "../journal";
import type { MetricsRecorder } from "../metrics";

const ROUTES = `
/dashboard /dashboard/:page /dashboard/runs/:id/transcript /dashboard/assets/:file / /status
/status/:page /evidence/:id /api/overview /api/issues /api/issues/:id
/api/issues/:id/attempts/:attempt/checks/:check/log /api/questions /api/questions/:id
/api/merge-queue /api/evidence /api/evidence/:id/metadata /api/evidence/:id /api/evidence/*
/api/notebooks /api/notebooks/:kind/:id /api/notebooks/:kind/:id/edits
/api/notebooks/:kind/:id/undo /api/aliases/:kind/:id /api/status /api/status/items/:id
/api/closeout-artifact /api/runs/transcript /api/linear/artifacts/* /api/linear/sessions
/api/link-asks /api/questions/answer /api/execution-controls /api/blocker-checks /api/fix-records
/api/findings /api/finding-groups /api/review-findings/issues /api/visual-review-changes
/api/settings/agents /api/settings/brief /api/settings/brief/preview /api/settings/closeout
/api/settings/findings /api/settings/hooks /api/settings/issue-vm /api/settings/splits
/api/settings/linear-comments
/api/settings/vm-sizes /api/settings/merging /api/settings/skills /api/settings/time-limits
/api/settings/github-access /api/settings/storage /api/settings/closeout-summary
/api/settings/repository-descriptions /api/settings/issue-vm/members
/api/settings/issue-vm/grants /api/settings/issue-vm/spend /api/settings/issue-vm/grants/:id
/api/settings/runner-vm-keys
/api/settings/vm-providers /api/settings/vm-providers/check /api/settings/doctor
/api/settings/storage/check /api/settings/telemetry /api/settings/telemetry/check
/api/metrics /api/metrics/stages /api/alerts /api/settings/storage-usage /api/settings/storage-usage/refresh
/api/settings/storage-cleanup /api/settings/storage-cleanup/preview
/api/settings/storage-cleanup/run /api/settings/storage-cleanup/history
/api/settings/probes/collect /api/retros/settings
/api/retros/schedule /api/retros/runs /api/retros/preview /api/retros/history
/api/retros/reports/:id /api/retros/reports/:id/digest /api/retros/reports/:id/report
/api/retros/reports/:id/prompt /api/retros/reports/:id/settings
/api/retros/reports/:id/items/:item/evidence /api/improvements /api/improvements/:id
/api/improvements/:id/decision /api/improvements/attention /api/improvements/:id/follow-through
/api/improvements/:id/delegate /api/improvements/:id/verification /api/improvements/:id/criterion
/api/improvements/:id/recovery /api/improvements/:id/deliveries/:delivery/retry
/api/improvements/:id/deliveries/:delivery/cancel
/api/improvements/:id/deliveries/:delivery/destination /api/runners /api/runners/:id/vm-host
/api/vm-hosts
/api/runners/enrollments /api/runners/usage /api/runners/models
/api/runners/coding-agents/update-all /api/runners/:id/coding-agents/:agent/update
/api/runners/:id/status /api/runners/:id/health /api/runners/:id/concurrency
/api/runners/:id/repositories /api/runners/:id/policy /api/runners/:id/fix-slots
/api/runners/:id/sessions/move /api/runners/:id/sessions/:session/move /api/runners/vm
/api/runners/vm/delete /api/runners/vm/retry /api/runners/vm/pool /api/runners/vm/pools
/api/runners/agent-accounts /api/runners/agent-accounts/order
/api/runners/agent-accounts/:id/extra-usage /api/runners/agent-accounts/:id/enabled
/api/runners/agent-accounts/:id /api/runners/agent-accounts/:id/sign-in
/api/runners/agent-accounts/:id/device /api/runners/agent-accounts/:id/credential
/api/runners/agent-accounts/:id/token /api/runners/agent-accounts/:id/api-key
/api/runner-enrollments /api/auth/session /api/auth/logout /api/workspaces /api/workspaces/select
/api/workspaces/members /api/workspaces/repositories /api/workspaces/audit
/api/workspaces/decisions /api/workspaces/github-attribution /api/workspaces/github-integration
/api/workspaces/github-connect /api/workspaces/github-app /api/workspaces/github-setup /setup
/auth/linear /auth/linear/callback /auth/linear/install/callback /auth/github-app/callback
/auth/github-attribution/callback /oauth/slack/callback /oauth/slack/link /api/workspaces/slack
/api/workspaces/slack/connect /api/workspaces/slack/adopt /api/workspaces/slack/link
/api/workspaces/slack/links /api/workspaces/slack/disclosure /api/settings/slack-app /onboard/:id
/onboard/:id/github /onboard/* /health /webhooks /webhooks/linear /webhooks/github
/webhooks/slack /dashboard/*
`
  .trim()
  .split(/\s+/)
  .map((pattern) => ({ pattern, parts: pattern.split("/") }));

function rank(parts: readonly string[]): string {
  return parts.map((part) => (part === "*" ? "2" : part.startsWith(":") ? "1" : "0")).join("");
}

function matches(pattern: readonly string[], parts: readonly string[]): boolean {
  const wildcard = pattern.at(-1) === "*";
  const fixed = wildcard ? pattern.length - 1 : pattern.length;
  if (wildcard ? parts.length <= fixed : parts.length !== fixed) return false;
  return pattern
    .slice(0, fixed)
    .every((part, index) => (part.startsWith(":") ? parts[index] !== "" : part === parts[index]));
}

export function routeName(path: string): string {
  const parts = path.split("/");
  let best: { pattern: string; rank: string } | null = null;
  for (const route of ROUTES) {
    if (!matches(route.parts, parts)) continue;
    const routeRank = rank(route.parts);
    if (best === null || routeRank < best.rank) best = { pattern: route.pattern, rank: routeRank };
  }
  return best?.pattern ?? "other";
}

async function responseBytes(response: Response): Promise<number> {
  const length = response.headers.get("content-length");
  if (length !== null && Number.isFinite(Number(length))) return Number(length);
  const body = response.clone().body;
  if (body === null) return 0;
  let bytes = 0;
  for await (const chunk of body) bytes += chunk.byteLength;
  return bytes;
}

export type RequestMetrics = Pick<MetricsRecorder, "recordDuration">;

export function observeRequest(
  metrics: RequestMetrics,
  request: Request,
  operation: Promise<Response>,
): Promise<Response> {
  const started = performance.now();
  const labels = (status: number) => ({
    route: routeName(new URL(request.url).pathname),
    method: request.method,
    status_class: `${Math.floor(status / 100)}xx`,
  });
  return operation.then(
    (response) => {
      const observed = labels(response.status);
      metrics.recordDuration("http.request", observed, performance.now() - started);
      responseBytes(response).then(
        (bytes) => metrics.recordDuration("http.response_bytes", observed, bytes),
        (error: unknown) => journalCaught(error, "serve.responseBytes", null),
      );
      return response;
    },
    (error: unknown) => {
      metrics.recordDuration("http.request", labels(500), performance.now() - started);
      throw error;
    },
  );
}
