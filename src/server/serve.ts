import { DEFAULT_HOST, DEFAULT_PORT } from "../config";
import { handleGitHubWebhook } from "../github";
import { handleLinearWebhook, type LinearWebhookDeps } from "../linear";
import { statusResponse } from "../web";

export type ServerOptions = {
  hostname?: string;
  port?: number;
  linearWebhookSecret?: string | null;
  githubWebhookSecret?: string | null;
  linearWebhook?: LinearWebhookDeps;
};

export function startServer(options: ServerOptions = {}): Bun.Server<undefined> {
  const hostname = options.hostname ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const linearWebhookSecret = options.linearWebhookSecret ?? null;
  const githubWebhookSecret = options.githubWebhookSecret ?? null;
  const linearWebhook = options.linearWebhook;
  return Bun.serve({
    hostname,
    port,
    fetch(request) {
      return route(request, { linearWebhookSecret, githubWebhookSecret, linearWebhook });
    },
  });
}

type Secrets = {
  linearWebhookSecret: string | null;
  githubWebhookSecret: string | null;
  linearWebhook: LinearWebhookDeps | undefined;
};

function route(request: Request, secrets: Secrets): Response | Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === "/health") {
    return Response.json({ ok: true, service: "paws" });
  }
  if (request.method === "GET" && path === "/status") {
    return statusResponse();
  }
  if (request.method === "POST" && path === "/webhooks/linear") {
    return handleLinearWebhook(request, secrets.linearWebhookSecret, secrets.linearWebhook);
  }
  if (request.method === "POST" && path === "/webhooks/github") {
    return handleGitHubWebhook(request, secrets.githubWebhookSecret);
  }
  return new Response("not found", { status: 404 });
}
