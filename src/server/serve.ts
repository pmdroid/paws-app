import { DEFAULT_HOST, DEFAULT_PORT } from "../config";
import { handleGitHubWebhook } from "../github";
import { handleLinearWebhook, type LinearWebhookDeps } from "../linear";
import { fakeStatusProvider, handleStatusRequest } from "../web";

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
  const statusProvider = fakeStatusProvider();
  return Bun.serve({
    hostname,
    port,
    fetch(request) {
      return route(request, {
        linearWebhookSecret,
        githubWebhookSecret,
        linearWebhook,
        statusProvider,
      });
    },
  });
}

type Secrets = {
  linearWebhookSecret: string | null;
  githubWebhookSecret: string | null;
  linearWebhook: LinearWebhookDeps | undefined;
  statusProvider: ReturnType<typeof fakeStatusProvider>;
};

async function route(request: Request, secrets: Secrets): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === "/health") {
    return Response.json({ ok: true, service: "paws" });
  }
  const status = await handleStatusRequest(request, { provider: secrets.statusProvider });
  if (status !== null) return status;
  if (request.method === "POST" && path === "/webhooks/linear") {
    return handleLinearWebhook(request, secrets.linearWebhookSecret, secrets.linearWebhook);
  }
  if (request.method === "POST" && path === "/webhooks/github") {
    return handleGitHubWebhook(request, secrets.githubWebhookSecret);
  }
  return new Response("not found", { status: 404 });
}
