import { createHash, createHmac } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  beginGitHubAttribution,
  consumeGitHubAttribution,
  githubAttribution,
  requireAttributionSession,
  revokeGitHubAttribution,
  saveGitHubAttribution,
  type AttributionBinding,
} from "../db";
import { readWorkspaceJson } from "./administration";
import {
  cookieValue,
  requestWorkspaceSession,
  validWorkspaceCsrf,
  workspaceSecret,
  workspaceTokenHash,
} from "./session";

const PATH = "/api/workspaces/github-attribution";
const CALLBACK = "/auth/github-attribution/callback";
const COOKIE = "__Host-paws-attribution";

export function createGitHubAttributionLink(options: {
  db: Database;
  origin: string;
  client: { clientId: string; clientSecret: string };
  refresh: (workspaceId: string, userId: string) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const http = options.fetch ?? fetch;
  const origin = new URL(options.origin).origin;
  if (!options.client.clientId || !options.client.clientSecret)
    throw new Error("Configured GitHub App client metadata is required.");
  return {
    async handle(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      if (![PATH, CALLBACK].includes(url.pathname)) return null;
      if (
        url.origin !== origin ||
        (request.headers.has("host") &&
          request.headers.get("host")?.toLowerCase() !== url.host.toLowerCase())
      )
        return reply({ error: "Use the configured Paws origin." }, 403);
      if (
        (url.pathname === CALLBACK && request.method !== "GET") ||
        (url.pathname === PATH && !["GET", "POST", "DELETE"].includes(request.method))
      )
        return reply({ error: "Method not allowed" }, 405);
      let access = requestWorkspaceSession(options.db, request, now());
      if (!access) return reply({ error: "Sign in to Paws." }, 401);
      const selected =
        url.searchParams.get("workspaceId") ?? request.headers.get("x-paws-workspace");
      if (selected !== null && selected !== access.principal.workspaceId)
        return reply({ error: "Workspace access denied." }, 403);
      const binding: AttributionBinding = {
        workspaceId: access.principal.workspaceId,
        userId: access.principal.userId,
        sessionHash: access.session.tokenHash,
      };
      if (
        url.pathname === PATH &&
        request.method !== "GET" &&
        (request.headers.get("origin") !== origin || !validWorkspaceCsrf(request, access.session))
      )
        return reply({ error: "CSRF token required." }, 403);
      try {
        await options.refresh(binding.workspaceId, binding.userId);
        access = requestWorkspaceSession(options.db, request, now());
        if (
          !access ||
          access.session.tokenHash !== binding.sessionHash ||
          access.principal.workspaceId !== binding.workspaceId
        )
          throw new Error("Session changed.");
        requireAttributionSession(options.db, binding, now());
        if (url.pathname === PATH) {
          if (request.method === "GET")
            return reply({
              identity: githubAttribution(options.db, binding.workspaceId, binding.userId),
            });
          if (request.method === "DELETE") {
            revokeGitHubAttribution(options.db, binding, now());
            return reply({ ok: true });
          }
          const body = await readWorkspaceJson(request);
          if (!record(body) || Object.keys(body).length !== 1 || body["consent"] !== true)
            return reply(
              {
                error:
                  "Explicit consent to public commit and pull request attribution is required.",
              },
              400,
            );
          const state = workspaceSecret();
          const browser = workspaceSecret();
          beginGitHubAttribution(options.db, binding, {
            stateHash: workspaceTokenHash(state),
            browserHash: workspaceTokenHash(browser),
            now: now(),
          });
          const target = new URL("https://github.com/login/oauth/authorize");
          target.search = new URLSearchParams({
            client_id: options.client.clientId,
            redirect_uri: `${origin}${CALLBACK}`,
            state,
            code_challenge: createHash("sha256")
              .update(verifier(browser, state))
              .digest("base64url"),
            code_challenge_method: "S256",
          }).toString();
          return reply({ authorizeUrl: target.href }, 200, {
            "set-cookie": `${COOKIE}=${browser}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
          });
        }
        const state = url.searchParams.get("state");
        const browser = cookieValue(request, COOKIE);
        if (
          !state ||
          !browser ||
          !/^[A-Za-z0-9_-]{43}$/.test(state) ||
          !/^[A-Za-z0-9_-]{43}$/.test(browser)
        )
          throw new Error("Invalid request.");
        const revision = consumeGitHubAttribution(options.db, binding, {
          stateHash: workspaceTokenHash(state),
          browserHash: workspaceTokenHash(browser),
          now: now(),
        });
        const code = url.searchParams.get("code");
        if (url.searchParams.has("error") || !code || code.length > 4096)
          throw new Error("Authorization not completed.");
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
        const exchange = await http("https://github.com/login/oauth/access_token", {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            client_id: options.client.clientId,
            client_secret: options.client.clientSecret,
            redirect_uri: `${origin}${CALLBACK}`,
            code,
            code_verifier: verifier(browser, state),
          }),
        });
        const grant: unknown = await exchange.json();
        if (
          !exchange.ok ||
          !record(grant) ||
          typeof grant["access_token"] !== "string" ||
          !/^ghu_[A-Za-z0-9_]+$/.test(grant["access_token"]) ||
          (grant["scope"] !== undefined && grant["scope"] !== "")
        )
          throw new Error("GitHub App identity authorization required.");
        const response = await http("https://api.github.com/user", {
          redirect: "error",
          signal,
          headers: {
            authorization: `Bearer ${grant["access_token"]}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
          },
        });
        const user: unknown = await response.json();
        if (
          !response.ok ||
          !record(user) ||
          user["type"] !== "User" ||
          !Number.isSafeInteger(user["id"]) ||
          Number(user["id"]) <= 0 ||
          typeof user["login"] !== "string" ||
          !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(user["login"])
        )
          throw new Error("A verified GitHub human account is required.");
        const id = Number(user["id"]);
        const login = user["login"];
        const name =
          (typeof user["name"] === "string" ? user["name"] : login)
            .replace(/[\p{C}<>]/gu, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 200)
            .trim() || login;
        await options.refresh(binding.workspaceId, binding.userId);
        saveGitHubAttribution(
          options.db,
          binding,
          { id, login, name, email: `${id}+${login}@users.noreply.github.com` },
          revision,
          now(),
        );
        return new Response(null, {
          status: 303,
          headers: {
            location: `${origin}/status`,
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "set-cookie": `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
          },
        });
      } catch {
        return reply(
          {
            error: "GitHub attribution could not be verified. Check membership and sign in again.",
          },
          403,
        );
      }
    },
  };
}

function verifier(browser: string, state: string) {
  return createHmac("sha256", browser).update(state).digest("base64url");
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function reply(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}
