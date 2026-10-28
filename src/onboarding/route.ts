import { journalCaught } from "../journal";
import { createHash, createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { writeSecretFile } from "../credentials";
import {
  consumeBrowserInstallation,
  consumeWorkspaceBootstrap,
  putWorkspaceUser,
  saveBrowserInstallation,
  syncWorkspaceMember,
  workspaceForOrganization,
} from "../db";
import {
  createLinearClient,
  createLinearMembershipReads,
  exchangeLinearCode,
  linearAuthorizeUrl,
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
import { handleStatusRequest } from "../web";
import { createLinearReconnect, type LinearReconnectSnapshot } from "./reconnect";

const INSTALL_COOKIE = "__Host-paws-install";
const CALLBACK = "/auth/linear/install/callback";

export function createBrowserOnboarding(options: {
  db: Database;
  home: string;
  origin: string;
  clientId: string | null;
  clientSecret: string | null;
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
  const tokenPath = join(home, "secrets", "linear-oauth.json");
  let installing = false;
  return async (request: Request, peer: WorkspaceClient = {}): Promise<Response> => {
    const url = new URL(request.url);
    if (
      url.origin !== origin ||
      (request.headers.has("host") && request.headers.get("host") !== url.host)
    )
      return Response.json({ error: "Use the configured Paws origin." }, { status: 403 });
    if (
      request.method !== "GET" &&
      !(request.method === "HEAD" && url.pathname.startsWith("/status"))
    )
      return Response.json({ error: "Method not allowed." }, { status: 405 });
    if (url.pathname === "/health") return Response.json({ ok: true, service: "paws" });
    const configured = !!options.clientId && !!options.clientSecret;
    if (url.pathname === "/api/auth/session")
      return Response.json(
        { onboarding: true, configured, reconnect: options.reconnect === true },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    if (url.pathname === "/" || url.pathname === "/status" || url.pathname.startsWith("/status/"))
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
        if (
          db.query("SELECT id FROM workspace LIMIT 1").get() !== null &&
          workspaceForOrganization(db, identity.organizationId) === null
        )
          return retry("workspace-mismatch");
        const state = workspaceSecret();
        const browser = workspaceSecret();
        saveBrowserInstallation(db, {
          stateHash: workspaceTokenHash(state),
          browserHash: workspaceTokenHash(browser),
          identity: JSON.stringify({
            identity,
            reconnect: options.reconnect
              ? createLinearReconnect({ fetch: fetchImpl, now })(home).snapshot
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
      return Response.json({ error: "Sign in to connect your Linear workspace." }, { status: 401 });
    if (installing || (existsSync(tokenPath) && !options.reconnect))
      return retry("already-connected");
    installing = true;
    try {
      const state = url.searchParams.get("state") ?? "";
      const browser = cookieValue(request, INSTALL_COOKIE) ?? "";
      if (![state, browser].every((value) => /^[A-Za-z0-9_-]{43}$/.test(value)))
        return retry("failed");
      const saved = consumeBrowserInstallation(
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
          hasToken: () => true,
          ensureFresh: async () => token.accessToken,
          forceRefresh: async () => token.accessToken,
        },
        fetch: (input, init) => fetchImpl(input, { ...init, signal, redirect: "error" }),
      });
      const memberships = createLinearMembershipReads(client);
      const organization = await memberships.installation(signal);
      if (organization.id !== identity.organizationId) return retry("workspace-mismatch");
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
      writeSecretFile(
        join(home, "secrets", "linear-client.json"),
        JSON.stringify({ clientId: options.clientId, clientSecret: options.clientSecret }),
      );
      if (reconnect) {
        const restored = await createLinearReconnect({ fetch: fetchImpl, snapshot: reconnect })(
          home,
        ).complete({ clientId: options.clientId!, token });
        if (!restored) return retry("workspace-mismatch");
      } else writeSecretFile(tokenPath, JSON.stringify(token), true);
      const timestamp = now();
      const userId = putWorkspaceUser(db, {
        id: workspaceId(),
        linearUserId: identity.userId,
        name: identity.name,
        email: identity.email,
      });
      let workspace = workspaceForOrganization(db, organization.id);
      if (workspace === null) {
        const grant = issueWorkspaceBootstrap(db, organization.id, timestamp);
        workspace = consumeWorkspaceBootstrap(db, {
          id: workspaceId(),
          organizationId: organization.id,
          name: organization.name,
          tokenHash: workspaceTokenHash(grant),
          userId,
          now: timestamp,
        });
      }
      syncWorkspaceMember(db, {
        workspaceId: workspace.id,
        userId,
        active: true,
        role: "member",
        teamIds: member.teamIds,
        now: timestamp + 1,
      });
      const session = issueWorkspaceSession(db, {
        workspaceId: workspace.id,
        userId,
        now: timestamp + 1,
      });
      const headers = new Headers({
        location: "/status/settings/integrations?connecting=1",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      headers.append("set-cookie", workspaceSessionCookie(session.token));
      headers.append(
        "set-cookie",
        `${INSTALL_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
      );
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
      location: `/status/?onboarding=${reason}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
