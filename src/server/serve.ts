import { createHostedGitHubConnect } from "./github-connect";
import { handleSlackWebhook } from "../slack";
import type { Database } from "bun:sqlite";
import type { PublicTls } from "../deployment";
import {
  createDashboardGitHubAuth,
  createGitHubInstallationCheck,
  createWorkspaceGitHubActivation,
} from "../auth";
import { DEFAULT_HOST, DEFAULT_PORT, loadRuntime } from "../config";
import { handleGitHubWebhook, type GitHubWebhook } from "../github";
import { handleLinearWebhook, webhookChecksNeeded, type LinearWebhookDeps } from "../linear";
import {
  fakeStatusProvider,
  handleStatusRequest,
  type ReadLinearArtifact,
  type StartLinearSession,
} from "../web";
import { handleAgentSettingsRequest, type AgentSettingsOptions } from "../settings";
import { auditWorkspaceAccess, getArtifact, getWorkItem, workspaceSessionIds } from "../db";
import {
  handleWorkspaceGitHubIntegration,
  requestWorkspaceSession,
  validWorkspaceCsrf,
  type WorkspaceAccess,
  type WorkspacePrincipal,
} from "../workspace";

export type ServerOptions = {
  tls?: PublicTls;
  workspaceAccess?: WorkspaceAccess | Promise<WorkspaceAccess>;
  runnerEnrollment?: (request: Request) => Promise<Response>;
  runnerControl?: (request: Request, principal: WorkspacePrincipal) => Promise<Response | null>;
  projects?: (request: Request, principal: WorkspacePrincipal) => Promise<Response | null>;
  executionControls?: (
    request: Request,
    principal: WorkspacePrincipal,
    sessionIds: readonly string[],
  ) => Promise<Response | null>;
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
  startLinearSession?: StartLinearSession;
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
  let workspaceAccess: WorkspaceAccess | null | undefined =
    options.workspaceAccess === undefined ? undefined : null;
  if (options.workspaceAccess !== undefined)
    void Promise.resolve(options.workspaceAccess).then(
      (value) => {
        workspaceAccess = value;
      },
      () => {},
    );
  const requests = new Set<Promise<Response>>();
  let stopping = false;
  const server = Bun.serve({
    hostname,
    port,
    ...(options.tls ? { tls: options.tls, development: false } : {}),
    fetch(request) {
      if (stopping) return new Response("Paws is stopping.", { status: 503 });
      const operation = route(request, {
        slackSigningSecret,
        linearWebhookSecret,
        githubWebhook,
        githubWebhookSecret,
        linearWebhook,
        webhooks,
        githubAuth,
        csrfToken,
        ...(workspaceAccess === undefined ? {} : { workspaceAccess }),
        ...(options.runnerEnrollment ? { runnerEnrollment: options.runnerEnrollment } : {}),
        ...(options.runnerControl ? { runnerControl: options.runnerControl } : {}),
        ...(options.projects ? { projects: options.projects } : {}),
        ...(options.executionControls ? { executionControls: options.executionControls } : {}),
        ...(options.readLinearArtifact ? { readLinearArtifact: options.readLinearArtifact } : {}),
        ...(options.startLinearSession ? { startLinearSession: options.startLinearSession } : {}),
        ...(options.agentSettings
          ? { agentSettings: { ...options.agentSettings, csrfToken } }
          : {}),
        ...(db ? { db } : {}),
        ...(statusEnv ? { statusEnv } : {}),
        ...(closeoutHome ? { closeoutHome } : {}),
        ...(evidenceRoot ? { evidenceRoot } : {}),
      });
      requests.add(operation);
      return operation.finally(() => requests.delete(operation));
    },
  });
  const stop = server.stop.bind(server);
  server.stop = async (closeActiveConnections) => {
    stopping = true;
    await stop(closeActiveConnections);
    await Promise.allSettled([...requests]);
  };
  return server;
}

type Secrets = {
  workspaceAccess?: WorkspaceAccess | null;
  runnerEnrollment?: ServerOptions["runnerEnrollment"];
  runnerControl?: ServerOptions["runnerControl"];
  projects?: ServerOptions["projects"];
  executionControls?: ServerOptions["executionControls"];
  slackSigningSecret: string | null;
  linearWebhookSecret: string | null;
  githubWebhookSecret: string | null;
  githubWebhook: GitHubWebhook | undefined;
  linearWebhook: LinearWebhookDeps | undefined;
  webhooks: boolean;
  githubAuth: ReturnType<typeof createDashboardGitHubAuth>;
  csrfToken: string;
  readLinearArtifact?: ReadLinearArtifact;
  startLinearSession?: StartLinearSession;
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
  if (path === "/api/runner-pairings" && secrets.runnerEnrollment !== undefined)
    return secrets.runnerEnrollment(request);
  if (secrets.workspaceAccess === null && !path.startsWith("/webhooks"))
    return Response.json(
      { error: "Paws workspace access is not ready. Check the Linear app installation." },
      { status: 503 },
    );
  const workspace = secrets.workspaceAccess ?? undefined;
  let csrfToken = secrets.csrfToken;
  let sessionIds: readonly string[] | undefined;
  if (workspace !== undefined) {
    const auth = await workspace.handle(request);
    if (auth !== null) return auth;
    if ((path === "/status" || path.startsWith("/status/")) && secrets.db !== undefined) {
      const access = requestWorkspaceSession(secrets.db, request, Date.now());
      if (access !== null) csrfToken = access.session.csrfToken;
    }
    if (
      (path === "/api/workspaces/github-connect" || path === "/auth/github-app/callback") &&
      secrets.db
    ) {
      try {
        await workspace.authenticate(request);
      } catch {
        return Response.json({ error: "Workspace access could not be verified." }, { status: 503 });
      }
      const env = secrets.statusEnv ?? process.env;
      const runtime = loadRuntime(env);
      return (await createHostedGitHubConnect({
        db: secrets.db,
        home: runtime.env.home,
        env,
        origin: workspace.origin,
      })(request))!;
    }
    if (path.startsWith("/api/")) {
      let access;
      try {
        access = await workspace.authenticate(request);
      } catch {
        return Response.json({ error: "Workspace access could not be verified." }, { status: 503 });
      }
      if (access === null || secrets.db === undefined)
        return Response.json({ error: "Sign in to Paws." }, { status: 401 });
      const selected =
        new URL(request.url).searchParams.get("workspaceId") ??
        request.headers.get("x-paws-workspace");
      if (selected !== null && selected !== access.principal.workspaceId) {
        auditWorkspaceAccess(secrets.db, {
          workspaceId: access.principal.workspaceId,
          userId: access.principal.userId,
          action: "access.denied",
          subject: path,
          now: Date.now(),
        });
        return Response.json({ error: "Workspace access denied." }, { status: 403 });
      }
      const privileged =
        path.startsWith("/api/settings/") ||
        path.startsWith("/api/auth/github") ||
        (path === "/api/linear/sessions" && request.method !== "GET");
      const unsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method);
      const recent =
        Date.now() >= access.principal.authenticatedAt &&
        Date.now() - access.principal.authenticatedAt <= 15 * 60_000;
      if (
        (privileged && (access.principal.role !== "owner" || (unsafe && !recent))) ||
        (unsafe &&
          (request.headers.get("origin") !== workspace.origin ||
            !validWorkspaceCsrf(request, access.session)))
      ) {
        auditWorkspaceAccess(secrets.db, {
          workspaceId: access.principal.workspaceId,
          userId: access.principal.userId,
          action: "access.denied",
          subject: path,
          now: Date.now(),
        });
        return Response.json(
          { error: "Workspace ownership, recent sign-in and a valid CSRF token are required." },
          { status: 403 },
        );
      }
      if (path === "/api/workspaces/github-integration") {
        const env = secrets.statusEnv ?? process.env;
        const runtime = loadRuntime(env);
        const activation = createWorkspaceGitHubActivation(secrets.db, runtime.env.home, env);
        const check = createGitHubInstallationCheck({
          home: runtime.env.home,
          env,
          resolve: (repository) => activation.resolve(repository),
        });
        return (await handleWorkspaceGitHubIntegration(request, {
          db: secrets.db,
          principal: access.principal,
          session: access.session,
          origin: workspace.origin,
          now: Date.now,
          check: (repository, signal) =>
            runtime.githubAuth === "app"
              ? check(repository, "write", signal)
              : Promise.resolve(false),
        }))!;
      }
      csrfToken = access.session.csrfToken;
      sessionIds = workspaceSessionIds(
        secrets.db,
        access.principal.workspaceId,
        access.principal.userId,
        workspace.clientId,
      );
      if (path === "/api/execution-controls" && secrets.executionControls !== undefined) {
        const response = await secrets.executionControls(request, access.principal, sessionIds);
        if (response !== null) return response;
      }
      if (path === "/api/projects" && secrets.projects !== undefined) {
        const response = await secrets.projects(request, access.principal);
        if (response !== null) return response;
      }
      if (path.startsWith("/api/runners") && secrets.runnerControl !== undefined) {
        const response = await secrets.runnerControl(request, access.principal);
        if (response !== null) return response;
      }
    }
  }
  if (path === "/api/runners" && request.method === "GET" && !secrets.runnerControl)
    return Response.json({
      runners: [],
      setupRequired: true,
      workspaceReady: workspace !== undefined,
    });
  if (secrets.agentSettings) {
    const settings = await handleAgentSettingsRequest(request, {
      ...secrets.agentSettings,
      csrfToken,
      ...(workspace === undefined ? {} : { trustedOrigin: workspace.origin }),
    });
    if (settings !== null) return settings;
  }
  const status = await handleStatusRequest(request, {
    csrfToken,
    ...(sessionIds === undefined ? {} : { sessionIds }),
    ...(workspace === undefined ? {} : { trustedOrigin: workspace.origin }),
    ...(secrets.readLinearArtifact
      ? {
          readLinearArtifact: async (id: string, signal?: AbortSignal) => {
            if (sessionIds !== undefined) {
              const artifact = getArtifact(secrets.db!, id);
              const item = artifact === null ? null : getWorkItem(secrets.db!, artifact.itemId);
              if (item?.sessionKey == null || !sessionIds.includes(item.sessionKey)) return null;
            }
            return secrets.readLinearArtifact!(id, signal);
          },
        }
      : {}),
    ...(secrets.startLinearSession ? { startLinearSession: secrets.startLinearSession } : {}),
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
  if (status !== null) {
    if (workspace === undefined) return status;
    const headers = new Headers(status.headers);
    for (const name of [...headers.keys()])
      if (name.toLowerCase().startsWith("access-control-")) headers.delete(name);
    return new Response(status.body, { status: status.status, headers });
  }
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
