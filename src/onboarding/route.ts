import { webhookFileDigest } from "./setup-runtime";
import { readWebhookBody } from "../webhook-body";
import { journalCaught } from "../journal";
import { createHash, createHmac } from "node:crypto";
import { join } from "node:path";
import { saveSecret, removeSecret } from "../credentials";
import {
  consumeBrowserInstallation,
  consumeWorkspaceBootstrap,
  putWorkspaceUser,
  saveBrowserInstallation,
  syncWorkspaceMember,
  workspaceForOrganization,
  workspaceOrganizationIds,
  type Db,
} from "../db";
import {
  createLinearClient,
  createLinearMembershipReads,
  exchangeLinearCode,
  linearAuthorizeUrl,
  readStoredToken,
  writeStoredToken,
} from "../linear";
import {
  beginWorkspaceOAuth,
  completeWorkspaceOAuth,
  cookieValue,
  createRateLimiter,
  issueWorkspaceBootstrap,
  issueWorkspaceSession,
  ONBOARDING_RATE_LIMITS,
  workspaceId,
  workspaceSecret,
  workspaceSessionCookie,
  workspaceTokenHash,
  type LinearBrowserIdentity,
  type WorkspaceClient,
} from "../workspace";
import { linearSetupPage, handleStatusRequest } from "../dashboard";
import { createLinearReconnect, type LinearReconnectSnapshot } from "./reconnect";
import { forgetSetupToken, setupNeededPage } from "./setup-token";
import { dashboardPath, isDashboardPage } from "../dashboard-links";

const SETUP_COOKIE = "__Host-paws-setup";
const INSTALL_COOKIE = "__Host-paws-install";
const CALLBACK = "/auth/linear/install/callback";

export function createBrowserOnboarding(options: {
  db: Db;
  home: string;
  origin: string;
  setupToken?: string;
  clientId: string | null;
  clientSecret: string | null;
  clientSecretOverride?: string;
  expectedOrganizationId?: string | null;
  installed: () => void;
  reconnect?: boolean;
  prepare?: () => Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const { db, origin, home } = options;
  const now = options.now ?? Date.now;
  const startsPerIp = createRateLimiter(ONBOARDING_RATE_LIMITS.startsPerIp, now);
  const fetchImpl = options.fetch ?? fetch;
  const secretsDir = join(home, "secrets");
  const clientFile = join(
    secretsDir,
    options.setupToken ? "linear-browser-client.json" : "linear-client.json",
  );
  const configuredOrganization = options.expectedOrganizationId?.trim() || null;
  function organizationFor(workspaces: string[]): string | null {
    if (workspaces.length === 0) return configuredOrganization;
    if (
      workspaces.length !== 1 ||
      (configuredOrganization !== null && configuredOrganization !== workspaces[0])
    )
      return null;
    return workspaces[0]!;
  }
  async function installationOrganization(): Promise<string | null> {
    return organizationFor(await workspaceOrganizationIds(db, 2));
  }
  async function organizationMatches(id: string): Promise<boolean> {
    const workspaces = await workspaceOrganizationIds(db, 2);
    return (
      organizationFor(workspaces) === id ||
      (!!options.setupToken && workspaces.length === 0 && configuredOrganization === null)
    );
  }
  let installing = false;
  let setupConnected = false;
  let saving = false;
  const initialClientSecret = options.clientSecretOverride;
  const setupBrowser = workspaceSecret();
  return async (request: Request, peer: WorkspaceClient = {}): Promise<Response> => {
    const url = new URL(request.url);
    if (
      url.origin !== origin ||
      (request.headers.has("host") && request.headers.get("host") !== url.host)
    )
      return Response.json({ error: "Use the configured Paws origin." }, { status: 403 });
    if (options.setupToken && !setupConnected) {
      const authorized = url.searchParams.get("token") === options.setupToken;
      if (url.pathname === "/setup") {
        if (!authorized) return new Response("Forbidden", { status: 403 });
        if (request.method === "GET") {
          const response = linearSetupPage(origin, options.setupToken);
          response.headers.append(
            "set-cookie",
            `${SETUP_COOKIE}=${setupBrowser}; Path=/; Secure; HttpOnly; SameSite=Lax`,
          );
          return response;
        }
        if (request.method !== "POST") return new Response(null, { status: 405 });
        if (request.headers.get("origin") !== origin)
          return new Response("Forbidden", { status: 403 });
        if (saving) return new Response("Setup is being saved.", { status: 409 });
        saving = true;
        try {
          const body = await readWebhookBody(request, 16384);
          if (body instanceof Response) return body;
          const form = new URLSearchParams(body.toString("utf8"));
          const values = ["clientId", "clientSecret", "webhookSecret"].map((key) =>
            form.get(key)?.trim(),
          );
          if (values.some((value) => !value || value.length > 4096))
            return new Response("Enter all three values.", { status: 400 });
          await saveSecret(join(secretsDir, "linear-setup-pending"), "pending");
          await saveSecret(
            clientFile,
            JSON.stringify({
              clientId: values[0],
              clientSecret: values[1],
              webhookFileDigest: webhookFileDigest(secretsDir),
            }),
          );
          await saveSecret(join(secretsDir, "linear-webhook"), values[2]!);
          options.clientId = values[0]!;
          options.clientSecret = initialClientSecret ?? values[1]!;
          const response = await beginWorkspaceOAuth(db, {
            clientId: options.clientId!,
            origin,
            now: now(),
            bootstrap: null,
          });
          response.headers.append(
            "set-cookie",
            `${SETUP_COOKIE}=${setupBrowser}; Path=/; Secure; HttpOnly; SameSite=Lax`,
          );
          return response;
        } finally {
          saving = false;
        }
      }
      const oauth = ["/auth/linear", "/auth/linear/callback", CALLBACK].includes(url.pathname);
      if (oauth && cookieValue(request, SETUP_COOKIE) !== setupBrowser)
        return new Response("Forbidden", { status: 403 });
      if (!oauth || !options.clientId || !options.clientSecret) return setupNeededPage();
    }
    if (url.pathname === "/setup") return new Response("Forbidden", { status: 403 });
    if (request.method !== "GET" && !(request.method === "HEAD" && isDashboardPage(url.pathname)))
      return Response.json({ error: "Method not allowed." }, { status: 405 });
    if (url.pathname === "/health") return Response.json({ ok: true, service: "paws" });
    const configured = !!options.clientId && !!options.clientSecret;
    if (url.pathname === "/api/auth/session")
      return Response.json(
        { onboarding: true, configured, reconnect: options.reconnect === true },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    if (isDashboardPage(url.pathname))
      return (await handleStatusRequest(request, {})) ?? new Response("Not found", { status: 404 });
    if (!configured)
      return Response.json(
        { error: "Configure the Linear app credentials on the Paws server." },
        { status: 503 },
      );
    if (url.pathname === "/auth/linear") {
      const limit = startsPerIp.take(peer.ip || "unknown");
      if (!limit.allowed)
        return Response.json(
          { error: "Too many sign-in attempts. Try again later." },
          {
            status: 429,
            headers: {
              "cache-control": "no-store",
              "retry-after": String(limit.retryAfterSeconds),
            },
          },
        );
      if (
        (await installationOrganization()) === null &&
        (!options.setupToken || (await workspaceOrganizationIds(db, 2)).length > 0)
      )
        return Response.json(
          { error: "Configure LINEAR_ORGANIZATION_ID to match this Paws workspace on the server." },
          { status: 503, headers: { "cache-control": "no-store" } },
        );
      return beginWorkspaceOAuth(db, {
        clientId: options.clientId!,
        origin,
        now: now(),
        bootstrap: null,
      });
    }
    if (url.pathname === "/auth/linear/callback") {
      try {
        const { identity } = await completeWorkspaceOAuth(db, request, {
          clientId: options.clientId!,
          origin,
          now: now(),
          fetch: fetchImpl,
        });
        if (!identity.admin || !identity.active || identity.guest) return retry("admin-required");
        if (!(await organizationMatches(identity.organizationId)))
          return retry("workspace-mismatch");
        const state = workspaceSecret();
        const browser = workspaceSecret();
        await saveBrowserInstallation(db, {
          stateHash: workspaceTokenHash(state),
          browserHash: workspaceTokenHash(browser),
          identity: JSON.stringify({
            identity,
            reconnect: options.reconnect
              ? (await createLinearReconnect({ fetch: fetchImpl, now })(db, home)).snapshot
              : null,
          }),
          expiresAt: now() + 600_000,
        });
        return new Response(null, {
          status: 303,
          headers: {
            location: linearAuthorizeUrl({
              clientId: options.clientId!,
              redirectUri: origin + CALLBACK,
              state,
              codeChallenge: createHash("sha256")
                .update(verifier(browser, state))
                .digest("base64url"),
            }),
            "set-cookie": `${INSTALL_COOKIE}=${browser}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          },
        });
      } catch (caughtError1) {
        journalCaught(caughtError1, "route.createBrowserOnboarding.completeWorkspaceOAuth", null);
        return retry("failed");
      }
    }
    if (url.pathname !== CALLBACK)
      return Response.json(
        {
          error: options.reconnect
            ? "Linear needs reconnecting. Sign in as a workspace admin to reconnect it."
            : "Sign in to connect your Linear workspace.",
        },
        { status: 401 },
      );
    const stored = await readStoredToken(db, secretsDir);
    if (installing || (stored !== null && !options.reconnect && !options.setupToken))
      return retry("already-connected");
    installing = true;
    try {
      const state = url.searchParams.get("state") ?? "";
      const browser = cookieValue(request, INSTALL_COOKIE) ?? "";
      if (![state, browser].every((value) => /^[A-Za-z0-9_-]{43}$/.test(value)))
        return retry("failed");
      const saved = await consumeBrowserInstallation(
        db,
        workspaceTokenHash(state),
        workspaceTokenHash(browser),
        now(),
      );
      const code = url.searchParams.get("code");
      if (!saved || url.searchParams.has("error") || !code || code.length > 4096)
        return retry("failed");
      const { identity, reconnect } = JSON.parse(saved) as {
        identity: LinearBrowserIdentity;
        reconnect: LinearReconnectSnapshot | null;
      };
      if (!!reconnect !== !!options.reconnect) return retry("failed");
      if (!(await organizationMatches(identity.organizationId))) return retry("workspace-mismatch");
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
      const token = await exchangeLinearCode({
        clientId: options.clientId!,
        clientSecret: options.clientSecret!,
        code,
        redirectUri: origin + CALLBACK,
        codeVerifier: verifier(browser, state),
        now: now(),
        fetch: (input, init) => fetchImpl(input, { ...init, signal, redirect: "error" }),
      });
      const client = createLinearClient({
        auth: {
          hasToken: async () => true,
          ensureFresh: async () => token.accessToken,
          forceRefresh: async () => token.accessToken,
        },
        fetch: (input, init) => fetchImpl(input, { ...init, signal, redirect: "error" }),
      });
      const memberships = createLinearMembershipReads(client);
      const organization = await memberships.installation(signal);
      if (
        organization.id !== identity.organizationId ||
        !(await organizationMatches(organization.id))
      )
        return retry("workspace-mismatch");
      const member = await memberships.member(organization.id, identity.userId, signal);
      if (
        !member.active ||
        !member.admin ||
        member.guest ||
        member.userId !== identity.userId ||
        member.organizationId !== organization.id
      )
        return retry("admin-required");
      await options.prepare?.();
      signal.throwIfAborted();
      const bound = await organizationMatches(organization.id);
      signal.throwIfAborted();
      if (!bound) return retry("workspace-mismatch");
      if (!options.setupToken)
        await saveSecret(
          clientFile,
          JSON.stringify({ clientId: options.clientId, clientSecret: options.clientSecret }),
        );
      if (reconnect) {
        const restored = await (
          await createLinearReconnect({ fetch: fetchImpl, snapshot: reconnect })(db, home)
        ).complete({ clientId: options.clientId!, token });
        if (!restored) return retry("workspace-mismatch");
      } else if (!(await writeStoredToken(db, secretsDir, token, !options.setupToken)))
        return retry("already-connected");
      const timestamp = now();
      const userId = await putWorkspaceUser(db, {
        id: workspaceId(),
        linearUserId: identity.userId,
        name: identity.name,
        email: identity.email,
      });
      let workspace = await workspaceForOrganization(db, organization.id);
      if (workspace === null) {
        const grant = await issueWorkspaceBootstrap(db, organization.id, timestamp);
        workspace = await consumeWorkspaceBootstrap(db, {
          id: workspaceId(),
          organizationId: organization.id,
          name: organization.name,
          tokenHash: workspaceTokenHash(grant),
          userId,
          now: timestamp,
        });
      }
      await syncWorkspaceMember(db, {
        workspaceId: workspace.id,
        userId,
        active: true,
        role: "member",
        teamIds: member.teamIds,
        now: timestamp + 1,
      });
      const session = await issueWorkspaceSession(db, {
        workspaceId: workspace.id,
        userId,
        now: timestamp + 1,
      });
      const headers = new Headers({
        location: dashboardPath("/settings/integrations?connecting=1"),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      headers.append("set-cookie", workspaceSessionCookie(session.token));
      headers.append(
        "set-cookie",
        `${INSTALL_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
      );
      if (options.setupToken) {
        await removeSecret(join(secretsDir, "linear-setup-pending"));
        await forgetSetupToken(secretsDir);
      }
      setupConnected = true;
      options.installed();
      return new Response(null, { status: 303, headers });
    } catch (caughtError2) {
      journalCaught(caughtError2, "route.createBrowserOnboarding.get", null);
      return retry("failed");
    } finally {
      installing = false;
    }
  };
}

function verifier(browser: string, state: string): string {
  return createHmac("sha256", browser).update(state).digest("base64url");
}

function retry(reason: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: dashboardPath(`/?onboarding=${reason}`),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
