import { createHealthReport } from "./health";
import { journalCaught } from "../journal";
import { createGitHubRepositorySetup } from "./github-repository-setup";
import { createHostedGitHubConnect } from "./github-connect";
import { handleSlackWebhook } from "../slack";
import type { Database } from "bun:sqlite";
import type { PublicTls } from "../deployment";
import { createGitHubInstallationCheck, createWorkspaceGitHubActivation } from "../auth";
import { DEFAULT_HOST, DEFAULT_PORT, loadRuntime } from "../config";
import { handleGitHubWebhook, type GitHubWebhook } from "../github";
import {
  handleLinearWebhook,
  webhookChecksNeeded,
  type LinearUsage,
  type LinearWebhookDeps,
} from "../linear";
import {
  fakeStatusProvider,
  handleStatusRequest,
  statusSnapshots,
  type ReadLinearArtifact,
  type StartLinearSession,
} from "../web";
import {
  EVIDENCE_API_PATH,
  handleEvidenceRequest,
  handleVisualReviewChanges,
  VISUAL_REVIEW_CHANGES_PATH,
  type VisualReviewChanges,
} from "../evidence";
import {
  CHECKOUT_SETTINGS_PATH,
  HOOK_SETTINGS_PATH,
  SKILL_SETTINGS_PATH,
  handleAgentSettingsRequest,
  handleCheckoutSettingsRequest,
  handleMergeSettingsRequest,
  handleHookSettingsRequest,
  handleSkillSettingsRequest,
  MERGE_SETTINGS_PATH,
  type AgentSettingsOptions,
  type MergeChoices,
  type RepositoryCheckoutFacts,
} from "../settings";
import type { SkillResolver, SkillUpdates } from "../skills";
import {
  auditWorkspaceAccess,
  getArtifact,
  getWorkItem,
  listWorkspaceRepositoryNames,
  workspaceSessionIds,
} from "../db";
import {
  handleWorkspaceGitHubIntegration,
  requestWorkspaceSession,
  validWorkspaceCsrf,
  type WorkspaceAccess,
  type WorkspacePrincipal,
} from "../workspace";

export type ServerOptions = {
  server?: Bun.Server<undefined>;
  onboarding?: (request: Request) => Promise<Response | null>;
  tls?: PublicTls;
  workspaceAccess?: WorkspaceAccess | Promise<WorkspaceAccess>;
  /** `POST /api/runner-enrollments`, where a host enrolls itself with a member's token. */
  runnerHostEnrollment?: (request: Request) => Promise<Response>;
  runnerControl?: (request: Request, principal: WorkspacePrincipal) => Promise<Response | null>;
  executionControls?: (
    request: Request,
    principal: WorkspacePrincipal,
    sessionIds: readonly string[],
  ) => Promise<Response | null>;
  /** `POST /api/link-asks`: a decision a signed-in person makes on the item page. */
  linkAsks?: (
    request: Request,
    principal: WorkspacePrincipal | undefined,
    sessionIds: readonly string[] | undefined,
  ) => Promise<Response | null>;
  hostname?: string;
  port?: number;
  linearWebhookSecret?: string | null;
  githubWebhookSecret?: string | null;
  githubWebhook?: GitHubWebhook;
  slackSigningSecret?: string | null;
  linearWebhook?: LinearWebhookDeps;
  linearUsage?: () => LinearUsage;
  /**
   * Webhook routes. Default follows `LINEAR_WEBHOOKS` via `webhookChecksNeeded`.
   * Off, every `/webhooks/*` path is 404.
   */
  webhooks?: boolean;
  /** Engine database. `/api/status` reads it. Omit it for an empty live snapshot. */
  db?: Database;
  /** Clock for local health checks. */
  healthNow?: () => number;
  statusEnv?: Record<string, string | undefined>;
  closeoutHome?: string;
  evidenceRoot?: string;
  evidenceDir?: string;
  visualReviewChanges?: VisualReviewChanges;
  readLinearArtifact?: ReadLinearArtifact;
  startLinearSession?: StartLinearSession;
  agentSettings?: Omit<AgentSettingsOptions, "csrfToken"> & {
    /** Linear projects and labels for Settings → Merging. */
    mergeChoices?: (signal: AbortSignal) => Promise<MergeChoices>;
    /** Configured repositories whose main has a GitHub merge queue, for Settings → Merging. */
    githubQueues?: (signal: AbortSignal) => Promise<string[]>;
    upToDateRules?: (signal: AbortSignal) => Promise<string[]>;
    /** Whether high-risk pull requests wait for an approval in Paws, for Settings → Merging. */
    riskGate?: { on: boolean; reason?: string };
    /** Files and Closeout check paths of a repository's local mirror, for Repository checkout. */
    checkoutFacts?: (repo: string) => Promise<RepositoryCheckoutFacts | null>;
  };
  /** Registered agent skills: bundles under `root` (`~/.paws/skills`), pins in `db`. */
  skillSettings?: {
    root: string;
    resolver: SkillResolver;
    updates?: SkillUpdates;
    limit?: number;
  };
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
  const health = createHealthReport({
    db,
    linearWebhook: webhooks && Boolean(linearWebhookSecret),
    githubWebhook: webhooks && Boolean(githubWebhookSecret),
    now: options.healthNow,
  });
  const statusEnv = options.statusEnv;
  const closeoutHome = options.closeoutHome;
  const evidenceRoot = options.evidenceRoot;
  const csrfToken = crypto.randomUUID();
  let workspaceAccess: WorkspaceAccess | null | undefined =
    options.workspaceAccess === undefined ? undefined : null;
  if (options.workspaceAccess !== undefined)
    void Promise.resolve(options.workspaceAccess).then(
      (value) => {
        workspaceAccess = value;
      },
      (caughtError1) => {
        journalCaught(caughtError1, "serve.startServer.resolve", null);
      },
    );
  const requests = new Set<Promise<Response>>();
  let stopping = false;
  const serveOptions = {
    hostname,
    port,
    ...(options.tls ? { tls: options.tls, development: false } : {}),
    fetch(request: Request, current?: Bun.Server<undefined>) {
      if (stopping) return new Response("Paws is stopping.", { status: 503 });
      const ip = current?.requestIP(request)?.address ?? null;
      const operation = (async () =>
        (await options.onboarding?.(request)) ??
        route(request, {
          health,
          slackSigningSecret,
          linearWebhookSecret,
          githubWebhook,
          githubWebhookSecret,
          linearWebhook,
          linearUsage: options.linearUsage,
          webhooks,
          csrfToken,
          ip,
          ...(workspaceAccess === undefined ? {} : { workspaceAccess }),
          ...(options.runnerHostEnrollment
            ? { runnerHostEnrollment: options.runnerHostEnrollment }
            : {}),
          ...(options.runnerControl ? { runnerControl: options.runnerControl } : {}),
          ...(options.executionControls ? { executionControls: options.executionControls } : {}),
          ...(options.linkAsks ? { linkAsks: options.linkAsks } : {}),
          ...(options.readLinearArtifact ? { readLinearArtifact: options.readLinearArtifact } : {}),
          ...(options.startLinearSession ? { startLinearSession: options.startLinearSession } : {}),
          ...(options.agentSettings
            ? { agentSettings: { ...options.agentSettings, csrfToken } }
            : {}),
          ...(options.skillSettings ? { skillSettings: options.skillSettings } : {}),
          ...(db ? { db } : {}),
          ...(statusEnv ? { statusEnv } : {}),
          ...(closeoutHome ? { closeoutHome } : {}),
          ...(evidenceRoot ? { evidenceRoot } : {}),
          ...(options.evidenceDir ? { evidenceDir: options.evidenceDir } : {}),
          ...(options.visualReviewChanges
            ? { visualReviewChanges: options.visualReviewChanges }
            : {}),
        }))();
      requests.add(operation);
      return operation.finally(() => requests.delete(operation));
    },
  };
  const server = options.server ?? Bun.serve(serveOptions);
  if (options.server) server.reload(serveOptions);
  const stop = server.stop.bind(server);
  server.stop = async (closeActiveConnections) => {
    stopping = true;
    await stop(closeActiveConnections);
    await Promise.allSettled([...requests]);
  };
  return server;
}

type Secrets = {
  health: ReturnType<typeof createHealthReport>;
  /** The socket peer address, for the sign-in rate limits. */
  ip?: string | null;
  workspaceAccess?: WorkspaceAccess | null;
  runnerHostEnrollment?: ServerOptions["runnerHostEnrollment"];
  runnerControl?: ServerOptions["runnerControl"];
  executionControls?: ServerOptions["executionControls"];
  linkAsks?: ServerOptions["linkAsks"];
  slackSigningSecret: string | null;
  linearWebhookSecret: string | null;
  githubWebhookSecret: string | null;
  githubWebhook: GitHubWebhook | undefined;
  linearWebhook: LinearWebhookDeps | undefined;
  linearUsage?: (() => LinearUsage) | undefined;
  webhooks: boolean;
  csrfToken: string;
  readLinearArtifact?: ReadLinearArtifact;
  startLinearSession?: StartLinearSession;
  agentSettings?: ServerOptions["agentSettings"] & { csrfToken: string };
  skillSettings?: ServerOptions["skillSettings"];
  db?: Database;
  statusEnv?: Record<string, string | undefined>;
  closeoutHome?: string;
  evidenceRoot?: string;
  evidenceDir?: string;
  visualReviewChanges?: VisualReviewChanges;
};

async function route(request: Request, secrets: Secrets): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === "/health") {
    const usage = secrets.linearUsage?.();
    const report = secrets.health();
    return Response.json(
      { ...report, ...(usage ? { linear: usage } : {}) },
      { status: report.ok ? 200 : 503, headers: { "cache-control": "no-store" } },
    );
  }
  if (path === "/api/runner-enrollments" && secrets.runnerHostEnrollment !== undefined)
    return secrets.runnerHostEnrollment(request);
  if (secrets.workspaceAccess === null && !path.startsWith("/webhooks")) {
    if (path === "/" || path === "/status" || path.startsWith("/status/")) {
      const page = await handleStatusRequest(request, {});
      if (page !== null) return page;
    }
    return Response.json(
      { error: "Paws workspace access is not ready. Check the Linear app installation." },
      { status: 503 },
    );
  }
  const workspace = secrets.workspaceAccess ?? undefined;
  let csrfToken = secrets.csrfToken;
  let sessionIds: readonly string[] | undefined;
  let principal: WorkspacePrincipal | undefined;
  if (workspace !== undefined) {
    const auth = await workspace.handle(request, { ip: secrets.ip ?? null });
    if (auth !== null) return auth;
    if ((path === "/status" || path.startsWith("/status/")) && secrets.db !== undefined) {
      const access = requestWorkspaceSession(secrets.db, request, Date.now());
      if (access !== null) csrfToken = access.session.csrfToken;
    }
    if (
      (path === "/api/workspaces/github-connect" ||
        path === "/api/workspaces/github-setup" ||
        path === "/auth/github-app/callback") &&
      secrets.db
    ) {
      try {
        await workspace.authenticate(request);
      } catch (caughtError1) {
        journalCaught(caughtError1, "serve.route.authenticate", null);
        return Response.json({ error: "Workspace access could not be verified." }, { status: 503 });
      }
      const env = secrets.statusEnv ?? process.env;
      const runtime = loadRuntime(env);
      const setup = await createGitHubRepositorySetup({
        db: secrets.db,
        home: runtime.env.home,
        env,
        origin: workspace.origin,
        teams: (setupRequest, signal) => workspace.repositoryTeams(setupRequest, signal),
      })(request);
      if (setup) return setup;
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
      } catch (caughtError2) {
        journalCaught(caughtError2, "serve.route.authenticate", null);
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
        (path === "/api/linear/sessions" && request.method !== "GET");
      const unsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method);
      // Admins manage skills and merging next to owners; every other setting stays with owners.
      const roles = [SKILL_SETTINGS_PATH, MERGE_SETTINGS_PATH, HOOK_SETTINGS_PATH].includes(path)
        ? ["owner", "admin"]
        : ["owner"];
      if (
        (privileged && !roles.includes(access.principal.role)) ||
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
          { error: "Workspace ownership and a valid CSRF token are required." },
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
          check: (repository, signal) => check(repository, "write", signal),
        }))!;
      }
      csrfToken = access.session.csrfToken;
      principal = access.principal;
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
      if (path.startsWith("/api/runners") && secrets.runnerControl !== undefined) {
        const response = await secrets.runnerControl(request, access.principal);
        if (response !== null) return response;
      }
    }
  }
  if (path === "/api/link-asks" && secrets.linkAsks !== undefined) {
    const response = await secrets.linkAsks(request, principal, sessionIds);
    if (response !== null) return response;
  }
  if (path === VISUAL_REVIEW_CHANGES_PATH) {
    if (!secrets.db || !secrets.evidenceDir || !secrets.visualReviewChanges)
      return Response.json({ error: "Not found." }, { status: 404 });
    return (await handleVisualReviewChanges(request, {
      db: secrets.db,
      root: secrets.evidenceDir,
      principal,
      sessionIds,
      submit: secrets.visualReviewChanges,
    }))!;
  }
  if (path.startsWith(EVIDENCE_API_PATH)) {
    if (secrets.db === undefined || secrets.evidenceDir === undefined)
      return Response.json({ error: "Not found." }, { status: 404 });
    return (await handleEvidenceRequest(request, {
      db: secrets.db,
      root: secrets.evidenceDir,
      sessionIds,
    }))!;
  }
  if (path === "/api/runners" && request.method === "GET" && !secrets.runnerControl)
    return Response.json({
      runners: [],
      setupRequired: true,
      workspaceReady: workspace !== undefined,
    });
  if (path === SKILL_SETTINGS_PATH && secrets.skillSettings && secrets.db) {
    const db = secrets.db;
    return (await handleSkillSettingsRequest(request, {
      ...secrets.skillSettings,
      db,
      csrfToken,
      ...(principal === undefined ? {} : { role: principal.role }),
      audit: (action, subject) =>
        auditWorkspaceAccess(db, {
          workspaceId: principal?.workspaceId ?? null,
          userId: principal?.userId ?? null,
          action,
          subject,
          now: Date.now(),
        }),
      ...(workspace === undefined ? {} : { trustedOrigin: workspace.origin }),
    }))!;
  }
  if (path === HOOK_SETTINGS_PATH && secrets.db) {
    const db = secrets.db;
    return (await handleHookSettingsRequest(request, {
      db,
      csrfToken,
      ...(principal === undefined ? {} : { role: principal.role }),
      audit: (action, subject) =>
        auditWorkspaceAccess(db, {
          workspaceId: principal?.workspaceId ?? null,
          userId: principal?.userId ?? null,
          action,
          subject,
          now: Date.now(),
        }),
      ...(workspace === undefined ? {} : { trustedOrigin: workspace.origin }),
    }))!;
  }
  if (secrets.agentSettings) {
    const { mergeChoices, githubQueues, upToDateRules, riskGate, checkoutFacts, ...agentSettings } =
      secrets.agentSettings;
    const shared = {
      ...agentSettings,
      csrfToken,
      ...(principal === undefined || secrets.db === undefined
        ? {}
        : {
            audit: (action: string, subject: string) =>
              auditWorkspaceAccess(secrets.db!, {
                workspaceId: principal!.workspaceId,
                userId: principal!.userId,
                action,
                subject,
                now: Date.now(),
              }),
          }),
      ...(workspace === undefined ? {} : { trustedOrigin: workspace.origin }),
    };
    const settings =
      (await handleAgentSettingsRequest(request, shared)) ??
      (await handleCheckoutSettingsRequest(request, {
        ...shared,
        ...(path === CHECKOUT_SETTINGS_PATH && secrets.db
          ? {
              // The stored GitHub connection and team mappings, not a GitHub call.
              repos: [
                ...(shared.repos ?? []),
                ...listWorkspaceRepositoryNames(secrets.db, principal?.workspaceId),
              ],
            }
          : {}),
        ...(checkoutFacts ? { inspect: checkoutFacts } : {}),
      })) ??
      (await handleMergeSettingsRequest(request, {
        ...shared,
        ...(mergeChoices ? { choices: mergeChoices } : {}),
        ...(githubQueues ? { githubQueues } : {}),
        ...(upToDateRules ? { upToDateRules } : {}),
        ...(riskGate ? { riskGate } : {}),
      }));
    if (settings !== null) return settings;
  }
  const status = await handleStatusRequest(request, {
    csrfToken,
    snapshotCache: statusSnapshots,
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
    ...(secrets.db
      ? {
          db: secrets.db,
          ...(secrets.linearUsage ? { linearUsage: secrets.linearUsage } : {}),
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
