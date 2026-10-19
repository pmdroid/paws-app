import { handleDecisions } from "./decisions";
import { createGitHubAttributionLink } from "./github-attribution";
import type { Database } from "bun:sqlite";
import type { WorkspaceAssignments } from "./assignments";
import {
  auditWorkspaceAccess,
  consumeWorkspaceBootstrap,
  deleteWorkspaceSession,
  getWorkspace,
  listUserWorkspaces,
  listWorkspaceMembers,
  putWorkspaceUser,
  syncWorkspaceMember,
  workspaceForOrganization,
  workspaceMember,
} from "../db";
import type { LinearMembershipReads } from "../linear";
import type { SlackIdentityReads } from "../slack";
import { createWorkspaceIdentityLinks } from "./identity-links";
import { createWorkspaceLinearActions } from "./linear-actions";
import { beginWorkspaceOAuth, completeWorkspaceOAuth } from "./oauth";
import { handleWorkspaceAdministration, readWorkspaceJson } from "./administration";
import {
  clearWorkspaceSessionCookie,
  issueWorkspaceSession,
  issueWorkspaceBootstrap,
  requestWorkspaceSession,
  validWorkspaceCsrf,
  workspaceId,
  workspaceSessionCookie,
  workspaceTokenHash,
} from "./session";

export type WorkspaceAccessOptions = {
  db: Database;
  assignments?: WorkspaceAssignments;
  publicUrl: string;
  clientId: string;
  installedOrganization: { id: string; name: string };
  memberships: LinearMembershipReads;
  fetch?: typeof fetch;
  now?: () => number;
  slackIdentities?: SlackIdentityReads | null;
  githubAttributionClient?: { clientId: string; clientSecret: string };
  verifyTeam?: (id: string, signal: AbortSignal) => Promise<boolean>;
  readTeams?: (signal: AbortSignal) => Promise<{ id: string; name: string; key: string }[]>;
};

export function createWorkspaceAccess(options: WorkspaceAccessOptions) {
  const configured = new URL(options.publicUrl);
  if (
    configured.username ||
    configured.password ||
    (configured.protocol !== "https:" &&
      !(
        configured.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(configured.hostname)
      ))
  )
    throw new Error("Paws browser sign-in requires an HTTPS origin.");
  const origin = configured.origin;
  const now = options.now ?? Date.now;
  const authorizeLinearEvent = createWorkspaceLinearActions({
    db: options.db,
    organizationId: options.installedOrganization.id,
    clientId: options.clientId,
    memberships: options.memberships,
    now,
  });
  const links = createWorkspaceIdentityLinks({
    db: options.db,
    slack: options.slackIdentities,
    now,
  });
  const pending = new Map<string, Promise<void>>();
  async function refresh(
    workspaceKey: string,
    userId: string,
    force = false,
    permitted = false,
  ): Promise<void> {
    const member = workspaceMember(options.db, workspaceKey, userId);
    const workspace = getWorkspace(options.db, workspaceKey);
    if (
      member === null ||
      workspace === null ||
      workspace.organizationId !== options.installedOrganization.id
    )
      throw new Error("This workspace is not installed.");
    const observedAt = now();
    if (!force && member.checkedAt <= observedAt && observedAt - member.checkedAt < 5 * 60_000)
      return;
    const key = `${workspaceKey}:${userId}`;
    let operation = pending.get(key);
    if (force && operation !== undefined) {
      await operation.catch(() => {});
      return refresh(workspaceKey, userId, true, permitted);
    }
    if (operation === undefined) {
      operation = options.memberships
        .member(workspace.organizationId, member.linearUserId, AbortSignal.timeout(10_000))
        .then((identity) => {
          if (
            identity.userId !== member.linearUserId ||
            identity.organizationId !== workspace.organizationId
          )
            throw new Error("Linear returned another member.");
          const applied = syncWorkspaceMember(options.db, {
            workspaceId: workspaceKey,
            userId,
            active: identity.active,
            role: identity.guest ? "observer" : "member",
            teamIds: identity.teamIds,
            now: observedAt,
          });
          if (permitted && (!applied || !identity.active || identity.guest))
            throw new Error("Current permitted Linear membership is required for attribution.");
        });
      pending.set(key, operation);
    }
    try {
      await operation;
    } finally {
      if (pending.get(key) === operation) pending.delete(key);
    }
  }
  const attribution = createGitHubAttributionLink({
    db: options.db,
    origin,
    client: options.githubAttributionClient,
    refresh: (workspaceKey, userId) => refresh(workspaceKey, userId, true, true),
    fetch: options.fetch,
    now,
  });
  async function refreshMemberships() {
    const workspace = workspaceForOrganization(options.db, options.installedOrganization.id);
    if (workspace === null) return;
    for (const member of listWorkspaceMembers(options.db, workspace.id))
      await refresh(workspace.id, member.id, true);
    await links.syncWorkspace(workspace.id);
  }
  async function authenticate(request: Request) {
    if (new URL(request.url).origin !== origin) return null;
    const current = requestWorkspaceSession(options.db, request, now());
    if (current === null) return null;
    await refresh(current.principal.workspaceId, current.principal.userId);
    return requestWorkspaceSession(options.db, request, now());
  }
  async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const path = url.pathname;
    const identityResponse = await attribution.handle(request);
    if (identityResponse) return identityResponse;
    if (
      ![
        "/auth/linear",
        "/auth/linear/callback",
        "/api/auth/session",
        "/api/workspaces/identity-links",
        "/api/workspaces/audit",
        "/api/workspaces/decisions",
        "/api/auth/logout",
        "/api/workspaces",
        "/api/workspaces/members",
        "/api/workspaces/repositories",
        "/api/workspaces/select",
      ].includes(path)
    )
      return null;
    if (
      url.origin !== origin ||
      (request.headers.has("host") &&
        request.headers.get("host")?.toLowerCase() !== url.host.toLowerCase())
    )
      return json({ error: "Use the configured Paws origin." }, 403);
    if (path === "/auth/linear") {
      if (!["GET", "POST"].includes(request.method))
        return json({ error: "Method not allowed" }, 405);
      let bootstrap: string | null = null;
      if (request.method === "POST") {
        if (request.headers.get("origin") !== origin) return json({ error: "Forbidden" }, 403);
        if (Number(request.headers.get("content-length") ?? 0) > 4096)
          return json({ error: "Invalid bootstrap grant" }, 400);
        let body: string;
        try {
          body = await smallBody(request);
        } catch {
          return json({ error: "Invalid bootstrap grant" }, 400);
        }
        bootstrap = new URLSearchParams(body).get("bootstrap");
        if (bootstrap !== null && !/^[A-Za-z0-9_-]{43}$/.test(bootstrap))
          return json({ error: "Invalid bootstrap grant" }, 400);
      }
      const token = url.searchParams.get("assignment");
      const assignmentHash = token === null ? null : options.assignments?.begin(token);
      if (token !== null && !assignmentHash)
        return json(
          { error: "Assignment sign-in is unavailable. Use the latest Linear sign-in action." },
          400,
        );
      return beginWorkspaceOAuth(options.db, {
        clientId: options.clientId,
        origin,
        now: now(),
        bootstrap,
        assignmentHash,
      });
    }
    if (path === "/auth/linear/callback") {
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      try {
        const result = await completeWorkspaceOAuth(options.db, request, {
          clientId: options.clientId,
          origin,
          now: now(),
          fetch: options.fetch ?? fetch,
        });
        if (result.identity.organizationId !== options.installedOrganization.id)
          return json({ error: "This Linear workspace is not installed in Paws." }, 403);
        const observedAt = now();
        const identity = await options.memberships.member(
          result.identity.organizationId,
          result.identity.userId,
          AbortSignal.timeout(10_000),
        );
        if (
          !identity.active ||
          identity.userId !== result.identity.userId ||
          identity.organizationId !== result.identity.organizationId
        )
          return json({ error: "Current Linear membership is required." }, 403);
        const userId = putWorkspaceUser(options.db, {
          id: workspaceId(now()),
          linearUserId: result.identity.userId,
          name: result.identity.name,
          email: result.identity.email,
        });
        let workspace = workspaceForOrganization(options.db, result.identity.organizationId);
        let syncAt = observedAt;
        if (result.bootstrapHash !== null) {
          if (identity.guest) return json({ error: "Guests cannot bootstrap a workspace." }, 403);
          syncAt = now();
          workspace = consumeWorkspaceBootstrap(options.db, {
            id: workspaceId(now()),
            organizationId: result.identity.organizationId,
            name: options.installedOrganization.name,
            tokenHash: result.bootstrapHash,
            userId,
            now: syncAt,
          });
        }
        if (workspace === null) {
          if (!identity.admin || identity.guest)
            return json(
              { error: "A Linear workspace admin must connect this workspace first." },
              403,
            );
          const grant = issueWorkspaceBootstrap(options.db, result.identity.organizationId, now());
          workspace = consumeWorkspaceBootstrap(options.db, {
            id: workspaceId(now()),
            organizationId: result.identity.organizationId,
            name: options.installedOrganization.name,
            tokenHash: workspaceTokenHash(grant),
            userId,
            now: now(),
          });
        }
        syncWorkspaceMember(options.db, {
          workspaceId: workspace.id,
          userId,
          active: true,
          role: identity.guest ? "observer" : "member",
          teamIds: identity.teamIds,
          now: syncAt,
        });
        if (result.assignmentHash !== null) {
          if (!options.assignments) throw new Error("Assignment sign-in is unavailable.");
          options.assignments.complete(result.assignmentHash, workspace.id, result.identity.userId);
        }
        await links.syncUser(workspace.id, userId);
        const previous = requestWorkspaceSession(options.db, request, now());
        if (previous !== null) deleteWorkspaceSession(options.db, previous.session.tokenHash);
        const issued = issueWorkspaceSession(options.db, {
          userId,
          workspaceId: workspace.id,
          now: now(),
        });
        const headers = new Headers({
          location: "/status/",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        });
        headers.append("set-cookie", workspaceSessionCookie(issued.token));
        headers.append(
          "set-cookie",
          "__Host-paws-login=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
        );
        return new Response(null, { status: 303, headers });
      } catch {
        return json({ error: "Linear sign-in could not be completed. Start sign-in again." }, 400);
      }
    }
    let access;
    try {
      access =
        path === "/api/auth/logout"
          ? requestWorkspaceSession(options.db, request, now())
          : await authenticate(request);
    } catch {
      return json({ error: "Linear membership could not be refreshed." }, 503);
    }
    if (access === null) return json({ error: "Sign in to Paws." }, 401);
    const selected = url.searchParams.get("workspaceId") ?? request.headers.get("x-paws-workspace");
    if (selected !== null && selected !== access.principal.workspaceId)
      return json({ error: "Workspace access denied." }, 403);
    if (path === "/api/workspaces/select") {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      if (request.headers.get("origin") !== origin || !validWorkspaceCsrf(request, access.session))
        return json({ error: "CSRF token required." }, 403);
      const body = await readWorkspaceJson(request).catch(() => null);
      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        !("workspaceId" in body) ||
        body.workspaceId !== access.principal.workspaceId
      )
        return json({ error: "This workspace is not installed or authorized." }, 403);
      return json({ ok: true });
    }
    const decisionResponse = await handleDecisions(request, {
      db: options.db,
      ...access,
      origin,
      clientId: options.clientId,
      now,
    });
    if (decisionResponse !== null) return decisionResponse;
    const identityAdministration = await links.handle(request, { ...access, origin, now: now() });
    if (identityAdministration !== null) return identityAdministration;
    const administration = await handleWorkspaceAdministration(request, {
      db: options.db,
      ...access,
      origin,
      now: now(),
      verifyTeam: options.verifyTeam,
      memberships: options.memberships,
    });
    if (administration !== null) return administration;
    if (path === "/api/auth/session" && request.method === "GET")
      return json({
        ...access.principal,
        user: (() => {
          const member = workspaceMember(
            options.db,
            access.principal.workspaceId,
            access.principal.userId,
          );
          return member ? { name: member.name, email: member.email } : null;
        })(),
        csrfToken: access.session.csrfToken,
        workspaces: listUserWorkspaces(options.db, access.principal.userId),
      });
    if (path === "/api/workspaces" && request.method === "GET")
      return json({ workspaces: listUserWorkspaces(options.db, access.principal.userId) });
    if (path === "/api/auth/logout" && request.method === "POST") {
      if (request.headers.get("origin") !== origin || !validWorkspaceCsrf(request, access.session))
        return json({ error: "CSRF token required." }, 403);
      deleteWorkspaceSession(options.db, access.session.tokenHash);
      auditWorkspaceAccess(options.db, {
        workspaceId: access.principal.workspaceId,
        userId: access.principal.userId,
        action: "session.ended",
        subject: access.principal.userId,
        now: now(),
      });
      return Response.json(
        { ok: true },
        { headers: { "cache-control": "no-store", "set-cookie": clearWorkspaceSessionCookie() } },
      );
    }
    return json({ error: "Method not allowed" }, 405);
  }
  const operations = new Set<Promise<unknown>>();
  let closed = false;
  function track<T>(run: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new Error("Workspace access is stopping."));
    const operation = run();
    operations.add(operation);
    return operation.finally(() => operations.delete(operation));
  }
  return {
    authorizeLinearEvent: (event: Parameters<typeof authorizeLinearEvent>[0]) =>
      track(() => authorizeLinearEvent(event)),
    authenticate: (request: Request) => track(() => authenticate(request)),
    repositoryTeams: (request: Request, signal: AbortSignal) =>
      track(async () => {
        const access = await authenticate(request);
        if (access?.principal.role !== "owner" || !options.readTeams)
          throw new Error("Workspace team access is unavailable.");
        return options.readTeams(signal);
      }),
    handle: (request: Request) => track(() => handle(request)),
    origin,
    organizationId: options.installedOrganization.id,
    clientId: options.clientId,
    refreshMemberships: () => track(refreshMemberships),
    async stop() {
      closed = true;
      await Promise.allSettled([...operations]);
    },
  };
}

export type WorkspaceAccess = ReturnType<typeof createWorkspaceAccess>;

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

async function smallBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return Buffer.concat(chunks).toString("utf8");
      length += result.value.byteLength;
      if (length > 4096) {
        await reader.cancel();
        throw new Error("Request too large");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
}
