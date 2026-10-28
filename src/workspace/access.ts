import { journalCaught } from "../journal";
import { handleDecisions } from "./decisions";
import { createGitHubAttributionLink } from "./github-attribution";
import { LINEAR_GUEST_REFUSAL } from "./eligibility";
import type { Database } from "bun:sqlite";
import type { WorkspaceAssignments } from "./assignments";
import {
  auditWorkspaceAccess,
  consumeWorkspaceBootstrap,
  deleteWorkspaceSession,
  getWorkspace,
  githubAttribution,
  listUserWorkspaces,
  listWorkspaceMembers,
  membershipFresh,
  putWorkspaceUser,
  syncWorkspaceMember,
  workspaceForOrganization,
  workspaceMember,
} from "../db";
import { linearItem, type LinearMembershipReads } from "../linear";
import type { SlackIdentityReads } from "../slack";
import { createWorkspaceIdentityLinks } from "./identity-links";
import { createWorkspaceLinearActions } from "./linear-actions";
import { beginWorkspaceOAuth, completeWorkspaceOAuth } from "./oauth";
import { onboardingPage, type OnboardingReadinessReader } from "./onboarding-page";
import { createRateLimiter, ONBOARDING_RATE_LIMITS, type RateLimiter } from "./rate-limit";
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

const GITHUB_STEP = "/github";

export type WorkspaceAccessOptions = {
  db: Database;
  assignments?: WorkspaceAssignments;
  /** Runner and coding-agent state for the onboarding page. */
  onboardingReadiness?: OnboardingReadinessReader;
  /** Whether Paws can create a VM for a member, so onboarding offers Create VM. */
  createVmAvailable?: () => Promise<boolean>;
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
  /** Where over-limit counters are reported. Never receives a URL, code, state or cookie. */
  log?: (line: string) => void;
};

/** What the server knows about the connection, beyond the request itself. */
export type WorkspaceClient = {
  /** The socket peer address. Forwarded headers are not trusted. */
  ip?: string | null;
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
  const linearActions = createWorkspaceLinearActions({
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
  const log = options.log ?? ((line: string) => console.warn(line));
  const limits = {
    startsPerIp: createRateLimiter(ONBOARDING_RATE_LIMITS.startsPerIp, now),
    startsPerLink: createRateLimiter(ONBOARDING_RATE_LIMITS.startsPerLink, now),
    failedCallbacksPerIp: createRateLimiter(ONBOARDING_RATE_LIMITS.failedCallbacksPerIp, now),
  };
  /** Answers 429 and logs only the counter's name. Nothing reaches Linear or the outbox. */
  function limited(limiter: RateLimiter, retryAfterSeconds: number): Response {
    log(`Paws rate limit reached: ${limiter.rule.name}`);
    const response = json({ error: "Too many sign-in attempts. Try again later." }, 429);
    response.headers.set("retry-after", String(retryAfterSeconds));
    return response;
  }
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
    if (!force && membershipFresh(member, observedAt)) return;
    const key = `${workspaceKey}:${userId}`;
    let operation = pending.get(key);
    if (force && operation !== undefined) {
      await operation.catch((caughtError1) => {
        journalCaught(caughtError1, "access.refresh", null);
      });
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
            active: identity.active && !identity.guest,
            role: "member",
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
  /** A failing check offers only Add a host. */
  async function createVmAvailable(): Promise<boolean> {
    try {
      return (await options.createVmAvailable?.()) === true;
    } catch (caughtError2) {
      journalCaught(caughtError2, "access.createVmAvailable", null);
      return false;
    }
  }
  async function handle(request: Request, client: WorkspaceClient = {}): Promise<Response | null> {
    const url = new URL(request.url);
    const ip = client.ip || "unknown";
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
      ].includes(path) &&
      !path.startsWith("/onboard/")
    )
      return null;
    if (
      url.origin !== origin ||
      (request.headers.has("host") &&
        request.headers.get("host")?.toLowerCase() !== url.host.toLowerCase())
    )
      return json({ error: "Use the configured Paws origin." }, 403);
    if (path.startsWith("/onboard/")) {
      // `/onboard/<id>` is the page; `/onboard/<id>/github` starts its GitHub credit link.
      const github = path.endsWith(GITHUB_STEP);
      const linkId = path.slice("/onboard/".length, github ? -GITHUB_STEP.length : undefined);
      if (request.method !== (github ? "POST" : "GET"))
        return json({ error: "Method not allowed" }, 405);
      const perIp = limits.startsPerIp.take(ip);
      if (!perIp.allowed) return limited(limits.startsPerIp, perIp.retryAfterSeconds);
      const link = options.assignments?.open(linkId) ?? null;
      if (link === null) return notFound();
      // A finished link shows only its signed-in creator where the task stands. Anyone else,
      // signed in or not, gets the same 404 as an unknown link and learns nothing.
      const viewer =
        link.state === "done" ? requestWorkspaceSession(options.db, request, now()) : null;
      const member =
        link.state === "done" && viewer?.principal.workspaceId === link.workspaceId
          ? workspaceMember(options.db, link.workspaceId, viewer.principal.userId)
          : null;
      const creator =
        link.state === "done" && member?.active && member.linearUserId === link.actorId
          ? { link, member, viewer: viewer! }
          : null;
      if (github)
        // The return path comes from the hold this route just verified, never from the request.
        return creator === null
          ? notFound()
          : attribution.startFromPage(request, `/onboard/${creator.link.linkId}`);
      if (creator !== null) {
        const { link: done, member: owner, viewer: signedIn } = creator;
        const credit = githubAttribution(options.db, done.workspaceId, owner.userId);
        return onboardingPage({
          identifier: done.identifier,
          issueUrl: done.issueUrl,
          teamName: done.teamName,
          member: { name: owner.name, email: owner.email },
          memberOfTeam: owner.teamIds.includes(done.teamId),
          csrfToken: signedIn.session.csrfToken,
          readiness: options.onboardingReadiness?.({
            workspaceId: done.workspaceId,
            userId: owner.userId,
            teamId: done.teamId,
            projectLeadIds: done.projectLeadIds,
            now: now(),
          }) ?? {
            runner: { state: "needed" },
            agents: { claude: "waiting", codex: "waiting" },
            memberVm: false,
          },
          github: credit,
          createVm: await createVmAvailable(),
          // Without App client metadata there is nothing to start.
          githubLink:
            credit === null && attribution.configured
              ? {
                  action: `/onboard/${done.linkId}${GITHUB_STEP}`,
                  csrf: signedIn.session.csrfToken,
                }
              : null,
        });
      }
      if (link.state === "done") return notFound();
      const perLink = limits.startsPerLink.take(link.link);
      if (!perLink.allowed) return limited(limits.startsPerLink, perLink.retryAfterSeconds);
      return beginWorkspaceOAuth(options.db, {
        clientId: options.clientId,
        origin,
        now: now(),
        bootstrap: null,
        assignmentHash: link.hash,
      });
    }
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
        } catch (caughtError3) {
          journalCaught(caughtError3, "access.handle.smallBody", null);
          return json({ error: "Invalid bootstrap grant" }, 400);
        }
        bootstrap = new URLSearchParams(body).get("bootstrap");
        if (bootstrap !== null && !/^[A-Za-z0-9_-]{43}$/.test(bootstrap))
          return json({ error: "Invalid bootstrap grant" }, 400);
      }
      // Links that carried a secret in the query string were replaced by /onboard/<link id>.
      if (url.searchParams.has("assignment"))
        return json(
          {
            error:
              "This sign-in link was replaced. Use the latest Sign in to Paws action in Linear.",
          },
          410,
        );
      return beginWorkspaceOAuth(options.db, {
        clientId: options.clientId,
        origin,
        now: now(),
        bootstrap,
      });
    }
    if (path === "/auth/linear/callback") {
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      const failures = limits.failedCallbacksPerIp.check(ip);
      if (!failures.allowed)
        return limited(limits.failedCallbacksPerIp, failures.retryAfterSeconds);
      const response = await callback(request);
      if (response.status !== 303) limits.failedCallbacksPerIp.record(ip);
      return response;
    }
    return sessionRoutes(request, url, path);
  }
  async function callback(request: Request): Promise<Response> {
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
      const read = () =>
        options.memberships.member(
          result.identity.organizationId,
          result.identity.userId,
          AbortSignal.timeout(10_000),
        );
      // A link sign-in's membership read counts toward the held issue under /health.
      const held =
        result.assignmentHash === null
          ? null
          : (options.assignments?.issueIdentifier(result.assignmentHash) ?? null);
      const identity = await (held === null ? read() : linearItem(held, read));
      if (
        !identity.active ||
        identity.userId !== result.identity.userId ||
        identity.organizationId !== result.identity.organizationId
      )
        return json({ error: "Current Linear membership is required." }, 403);
      if (identity.guest) return json({ error: LINEAR_GUEST_REFUSAL }, 403);
      const userId = putWorkspaceUser(options.db, {
        id: workspaceId(now()),
        linearUserId: result.identity.userId,
        name: result.identity.name,
        email: result.identity.email,
      });
      let workspace = workspaceForOrganization(options.db, result.identity.organizationId);
      let syncAt = observedAt;
      if (result.bootstrapHash !== null) {
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
        if (!identity.admin)
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
        role: "member",
        teamIds: identity.teamIds,
        now: syncAt,
      });
      let location = "/status/";
      if (result.assignmentHash !== null) {
        if (!options.assignments) throw new Error("Assignment sign-in is unavailable.");
        const completion = options.assignments.complete(
          result.assignmentHash,
          workspace.id,
          result.identity.userId,
        );
        if (completion.outcome === "other-user") {
          const refusal = page(`This link belongs to ${completion.creatorName}.`, 403);
          refusal.headers.append(
            "set-cookie",
            "__Host-paws-login=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
          );
          return refusal;
        }
        location =
          completion.linkId === null
            ? issuePage(completion.identifier)
            : `/onboard/${completion.linkId}`;
      } else options.assignments?.releaseFor(workspace.id, result.identity.userId);
      await links.syncUser(workspace.id, userId);
      const previous = requestWorkspaceSession(options.db, request, now());
      if (previous !== null) deleteWorkspaceSession(options.db, previous.session.tokenHash);
      const issued = issueWorkspaceSession(options.db, {
        userId,
        workspaceId: workspace.id,
        now: now(),
      });
      const headers = new Headers({
        location,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      headers.append("set-cookie", workspaceSessionCookie(issued.token));
      headers.append(
        "set-cookie",
        "__Host-paws-login=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
      );
      return new Response(null, { status: 303, headers });
    } catch (caughtError4) {
      journalCaught(caughtError4, "access.callback.completeWorkspaceOAuth", null);
      return json({ error: "Linear sign-in could not be completed. Start sign-in again." }, 400);
    }
  }
  async function sessionRoutes(request: Request, url: URL, path: string): Promise<Response> {
    let access;
    try {
      access =
        path === "/api/auth/logout"
          ? requestWorkspaceSession(options.db, request, now())
          : await authenticate(request);
    } catch (caughtError5) {
      journalCaught(caughtError5, "access.sessionRoutes.requestWorkspaceSession", null);
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
      const body = await readWorkspaceJson(request).catch((caughtError6) => {
        journalCaught(caughtError6, "access.sessionRoutes.readWorkspaceJson", null);
        return null;
      });
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
    authorizeLinearEvent: (event: Parameters<typeof linearActions.authorize>[0]) =>
      track(() => linearActions.authorize(event)),
    recheckLinearEvent: linearActions.recheck,
    authenticate: (request: Request) => track(() => authenticate(request)),
    repositoryTeams: (request: Request, signal: AbortSignal) =>
      track(async () => {
        const access = await authenticate(request);
        if (access?.principal.role !== "admin" || !options.readTeams)
          throw new Error("Workspace team access is unavailable.");
        return options.readTeams(signal);
      }),
    handle: (request: Request, client?: WorkspaceClient) => track(() => handle(request, client)),
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

function notFound(): Response {
  return page("This sign-in link is not active.", 404);
}

function issuePage(identifier: string): string {
  return `/status/issues/${encodeURIComponent(identifier)}`;
}

function page(message: string, status: number): Response {
  const text = message
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Paws</title><main><p>${text}</p></main>\n`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    },
  );
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
