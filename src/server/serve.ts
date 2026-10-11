import { handleSlackWebhook } from "../slack";
import type { Database } from "bun:sqlite";
import { createDashboardGitHubAuth } from "../auth";
import { DEFAULT_HOST, DEFAULT_PORT } from "../config";
import { handleGitHubWebhook, type GitHubWebhook } from "../github";
import { handleLinearWebhook, webhookChecksNeeded, type LinearWebhookDeps } from "../linear";
import { fakeStatusProvider, handleStatusRequest, type ReadLinearArtifact } from "../web";
import { handleAgentSettingsRequest, type AgentSettingsOptions } from "../settings";

export type ServerOptions = {
  hostname?: string;
  port?: number;
  linearWebhookSecret?: string | null;
  githubWebhookSecret?: string | null;
  githubWebhook?: GitHubWebhook;
  slackSigningSecret?: string | null;
  linearWebhook?: LinearWebhookDeps;
  /**
   * Webhook routes. Default follows `LINEAR_WEBHOOKS` via `webhookChecksNeeded`.
   * Off, every `/webhooks/*` path is 404.
   */
  webhooks?: boolean;
  /** Engine database. `/api/status` reads it. Omit it and the route stays on the demo snapshot. */
  db?: Database;
  statusEnv?: Record<string, string | undefined>;
  closeoutHome?: string;
  evidenceRoot?: string;
  readLinearArtifact?: ReadLinearArtifact;
  agentSettings?: Omit<AgentSettingsOptions, "csrfToken">;
};

export function startServer(options: ServerOptions = {}): Bun.Server<undefined> {
  const hostname = options.hostname ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const linearWebhookSecret = options.linearWebhookSecret ?? null;
  const slackSigningSecret = options.slackSigningSecret ?? null;
  const githubWebhook = options.githubWebhook;
  const githubWebhookSecret = options.githubWebhookSecret ?? null;
  const linearWebhook = options.linearWebhook;
  const webhooks = options.webhooks ?? webhookChecksNeeded();
  const db = options.db;
  const statusEnv = options.statusEnv;
  const closeoutHome = options.closeoutHome;
  const evidenceRoot = options.evidenceRoot;
  const githubAuth = createDashboardGitHubAuth({ env: process.env });
  const csrfToken = crypto.randomUUID();
  return Bun.serve({
    hostname,
    port,
    fetch(request) {
      return route(request, {
        slackSigningSecret,
        linearWebhookSecret,
        githubWebhook,
        githubWebhookSecret,
        linearWebhook,
        webhooks,
        githubAuth,
        csrfToken,
        ...(options.readLinearArtifact ? { readLinearArtifact: options.readLinearArtifact } : {}),
        ...(options.agentSettings
          ? { agentSettings: { ...options.agentSettings, csrfToken } }
          : {}),
        ...(db ? { db } : {}),
        ...(statusEnv ? { statusEnv } : {}),
        ...(closeoutHome ? { closeoutHome } : {}),
        ...(evidenceRoot ? { evidenceRoot } : {}),
      });
    },
  });
}

type Secrets = {
  slackSigningSecret: string | null;
  linearWebhookSecret: string | null;
  githubWebhookSecret: string | null;
  githubWebhook: GitHubWebhook | undefined;
  linearWebhook: LinearWebhookDeps | undefined;
  webhooks: boolean;
  githubAuth: ReturnType<typeof createDashboardGitHubAuth>;
  csrfToken: string;
  readLinearArtifact?: ReadLinearArtifact;
  agentSettings?: AgentSettingsOptions;
  db?: Database;
  statusEnv?: Record<string, string | undefined>;
  closeoutHome?: string;
  evidenceRoot?: string;
};

async function route(request: Request, secrets: Secrets): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === "/health") {
    return Response.json({ ok: true, service: "paws" });
  }
  if (secrets.agentSettings) {
    const settings = await handleAgentSettingsRequest(request, secrets.agentSettings);
    if (settings !== null) return settings;
  }
  const status = await handleStatusRequest(request, {
    csrfToken: secrets.csrfToken,
    ...(secrets.readLinearArtifact ? { readLinearArtifact: secrets.readLinearArtifact } : {}),
    githubAuth: secrets.githubAuth,
    ...(secrets.db
      ? {
          db: secrets.db,
          ...(secrets.statusEnv ? { env: secrets.statusEnv } : {}),
          ...(secrets.closeoutHome ? { closeoutHome: secrets.closeoutHome } : {}),
          ...(secrets.evidenceRoot ? { evidenceRoot: secrets.evidenceRoot } : {}),
        }
      : {
          provider: fakeStatusProvider(),
          ...(secrets.statusEnv ? { env: secrets.statusEnv } : {}),
        }),
  });
  if (status !== null) return status;
  if (path === "/webhooks/slack") return handleSlackWebhook(request, secrets.slackSigningSecret);
  if (path === "/webhooks" || path.startsWith("/webhooks/")) {
    if (!secrets.webhooks) return new Response("not found", { status: 404 });
    if (request.method === "POST" && path === "/webhooks/linear") {
      return handleLinearWebhook(request, secrets.linearWebhookSecret, secrets.linearWebhook);
    }
    if (request.method === "POST" && path === "/webhooks/github") {
      return handleGitHubWebhook(request, secrets.githubWebhookSecret, secrets.githubWebhook);
    }
    return new Response("not found", { status: 404 });
  }
  return new Response("not found", { status: 404 });
}
