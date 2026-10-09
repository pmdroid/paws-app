import { DEFAULT_HOST, DEFAULT_PORT } from "../config";
import { handleGitHubWebhook } from "../github";
import { handleLinearWebhook, type LinearWebhookDeps } from "../linear";
import { demoStatus, statusResponse, type StatusReport } from "../web";
import { dashboardAuthorized, unauthorized } from "./auth";

export type ServerOptions = {
  hostname?: string;
  port?: number;
  hosted?: boolean;
  dashboardToken?: string | null;
  /** Live engine snapshot. When omitted, `/api/status` serves demo rows. */
  statusProvider?: () => StatusReport;
  linearWebhookSecret?: string | null;
  githubWebhookSecret?: string | null;
  linearWebhook?: LinearWebhookDeps;
};

export function startServer(options: ServerOptions = {}): Bun.Server<undefined> {
  const hostname = options.hostname ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const hosted = options.hosted === true;
  const dashboardToken = options.dashboardToken ?? null;
  const linearWebhookSecret = options.linearWebhookSecret ?? null;
  const githubWebhookSecret = options.githubWebhookSecret ?? null;
  const linearWebhook = options.linearWebhook;
  const statusProvider =
    options.statusProvider ?? (() => demoStatus({ mode: hosted ? "hosted" : "local" }));
  let boundPort = port;
  const server = Bun.serve({
    hostname,
    port,
    fetch(request) {
      return route(request, {
        linearWebhookSecret,
        githubWebhookSecret,
        linearWebhook,
        hosted,
        dashboardToken,
        hostname,
        port: () => boundPort,
        statusProvider,
      });
    },
  });
  boundPort = server.port ?? port;
  return server;
}

type Secrets = {
  linearWebhookSecret: string | null;
  githubWebhookSecret: string | null;
  linearWebhook: LinearWebhookDeps | undefined;
  hosted: boolean;
  dashboardToken: string | null;
  hostname: string;
  port: () => number;
  statusProvider: () => StatusReport;
};

function route(request: Request, secrets: Secrets): Response | Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "GET" && path === "/health") {
    return Response.json({ ok: true, service: "paws" });
  }
  if (request.method === "GET" && path === "/") {
    return Response.redirect(new URL("/status", url).toString(), 302);
  }
  if (request.method === "GET" && (path === "/status" || path === "/api/status")) {
    if (!dashboardAuthorized(request, secrets.dashboardToken, secrets.hosted)) {
      return unauthorized();
    }
    if (path === "/status") return statusResponse();
    return statusJson(secrets);
  }
  if (request.method === "POST" && path === "/webhooks/linear") {
    return handleLinearWebhook(request, secrets.linearWebhookSecret, secrets.linearWebhook);
  }
  if (request.method === "POST" && path === "/webhooks/github") {
    return handleGitHubWebhook(request, secrets.githubWebhookSecret);
  }
  return new Response("not found", { status: 404 });
}

function statusJson(secrets: Secrets): Response {
  try {
    const report = secrets.statusProvider();
    return Response.json(
      {
        ...report,
        listener: { host: secrets.hostname, port: secrets.port() },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { ok: false, reason: "status_unavailable" },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
