import { createHash, createHmac } from "node:crypto";
import type { Database } from "bun:sqlite";
import { immediate, requireMemberGitHubSession, type MemberGitHubBinding } from "../db";
import { createMemberGitHubClient } from "../github";
import { createMemberGitHubAccounts } from "./member-github";
import { readWorkspaceJson } from "./administration";
import {
  cookieValue,
  requestWorkspaceSession,
  validWorkspaceCsrf,
  workspaceSecret,
  workspaceTokenHash,
} from "./session";

const PATH = "/api/workspaces/member-github";
const CALLBACK = "/auth/member-github/callback";
const COOKIE = "__Host-paws-member-github";

export function createMemberGitHubOAuth(options: {
  db: Database;
  origin: string;
  secretsDir: string;
  client?: { clientId: string; clientSecret: string };
  refresh: (workspaceId: string, userId: string) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
  onboarding?: (sessionId: string, generation: number, binding: MemberGitHubBinding) => boolean;
}) {
  const { db } = options;
  const now = options.now ?? Date.now;
  const http = options.fetch ?? fetch;
  const origin = new URL(options.origin).origin;
  if (options.client && (!options.client.clientId || !options.client.clientSecret))
    throw new Error("Configured GitHub App client metadata is required.");
  const client = createMemberGitHubClient(http);
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
        return reply({ error: "Method not allowed." }, 405);
      const access = requestWorkspaceSession(db, request, now());
      if (!access) return reply({ error: "Sign in to Paws." }, 401);
      const selectedWorkspace =
        url.searchParams.get("workspaceId") ?? request.headers.get("x-paws-workspace");
      if (selectedWorkspace !== null && selectedWorkspace !== access.principal.workspaceId)
        return reply({ error: "Workspace access denied." }, 403);
      const binding: MemberGitHubBinding = {
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
      const accounts = createMemberGitHubAccounts({
        db,
        secretsDir: options.secretsDir,
        now,
        client: {
          ...client,
          async identity(token, signal) {
            const identity = await client.identity(token, signal);
            await options.refresh(binding.workspaceId, binding.userId);
            const browser = cookieValue(request, COOKIE);
            const encoded = browser?.split(".")[1];
            if (encoded) {
              const destination = JSON.parse(
                Buffer.from(encoded, "base64url").toString("utf8"),
              ) as { sessionId: string; generation: number };
              if (!options.onboarding?.(destination.sessionId, destination.generation, binding))
                throw new Error();
            }
            return identity;
          },
        },
      });
      try {
        await options.refresh(binding.workspaceId, binding.userId);
        requireMemberGitHubSession(db, binding, now());
        if (url.pathname === PATH) {
          if (request.method === "GET")
            return reply({
              configured: options.client !== undefined,
              identity: accounts.status(binding.workspaceId, binding.userId),
            });
          if (request.method === "DELETE") {
            accounts.unlink(binding);
            db.run("DELETE FROM member_github_oauth_request WHERE workspace_id=? AND user_id=?", [
              binding.workspaceId,
              binding.userId,
            ]);
            return reply({ ok: true });
          }
          if (!options.client)
            return reply({ error: "GitHub App sign-in is not configured." }, 503);
          const body: unknown = await readWorkspaceJson(request);
          if (!record(body) || Object.keys(body).some((key) => key !== "onboarding"))
            return reply({ error: "Invalid sign-in request." }, 400);
          let destination: { sessionId: string; generation: number } | null = null;
          if (body["onboarding"] !== undefined) {
            const selected = body["onboarding"];
            if (
              !record(selected) ||
              Object.keys(selected).length !== 2 ||
              typeof selected["sessionId"] !== "string" ||
              !/^[A-Za-z0-9_-]{1,128}$/.test(selected["sessionId"]) ||
              !Number.isSafeInteger(selected["generation"]) ||
              Number(selected["generation"]) < 0 ||
              Number(selected["generation"]) > 9999999999
            )
              throw new Error();
            destination = {
              sessionId: selected["sessionId"],
              generation: Number(selected["generation"]),
            };
            if (!options.onboarding?.(destination.sessionId, destination.generation, binding))
              throw new Error();
          }
          const state = workspaceSecret();
          const suffix = destination
            ? `.${Buffer.from(JSON.stringify(destination)).toString("base64url")}`
            : "";
          const browser = workspaceSecret() + suffix;
          immediate(db, () => {
            const revision = accounts.begin(binding);
            db.run(
              "DELETE FROM member_github_oauth_request WHERE expires_at<=? OR (workspace_id=? AND user_id=?)",
              [now(), binding.workspaceId, binding.userId],
            );
            db.run(
              "INSERT INTO member_github_oauth_request(state_hash,browser_hash,workspace_id,user_id,session_hash,revision,expires_at) VALUES(?,?,?,?,?,?,?)",
              [
                workspaceTokenHash(state),
                workspaceTokenHash(browser),
                binding.workspaceId,
                binding.userId,
                binding.sessionHash,
                revision,
                now() + 600_000,
              ],
            );
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
          return reply({ authorizeUrl: target.href }, 200, { "set-cookie": cookie(browser, 600) });
        }
        const state = url.searchParams.get("state");
        const browser = cookieValue(request, COOKIE);
        if (
          !state ||
          !browser ||
          !/^[A-Za-z0-9_-]{43}$/.test(state) ||
          !/^[A-Za-z0-9_-]{43}(?:\.[A-Za-z0-9_-]{1,400})?$/.test(browser)
        )
          throw new Error();
        const revision = immediate(db, () => {
          requireMemberGitHubSession(db, binding, now());
          const pending = db
            .query<{ revision: number }, [string, string, string, string, string, number]>(
              "DELETE FROM member_github_oauth_request WHERE state_hash=? AND browser_hash=? AND workspace_id=? AND user_id=? AND session_hash=? AND expires_at>? RETURNING revision",
            )
            .get(
              workspaceTokenHash(state),
              workspaceTokenHash(browser),
              binding.workspaceId,
              binding.userId,
              binding.sessionHash,
              now(),
            );
          if (!pending) throw new Error();
          return pending.revision;
        });
        const encodedDestination = browser.split(".")[1];
        const destination = encodedDestination
          ? (JSON.parse(Buffer.from(encodedDestination, "base64url").toString("utf8")) as {
              sessionId: string;
              generation: number;
            })
          : null;
        if (
          destination &&
          !options.onboarding?.(destination.sessionId, destination.generation, binding)
        )
          throw new Error();
        const code = url.searchParams.get("code");
        if (!options.client || url.searchParams.has("error") || !code || code.length > 4096)
          throw new Error();
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
          (grant["scope"] !== undefined && grant["scope"] !== "") ||
          (grant["token_type"] !== undefined && grant["token_type"] !== "bearer")
        )
          throw new Error();
        let expiresAt: number | null = null;
        if (grant["expires_in"] !== undefined) {
          if (!Number.isSafeInteger(grant["expires_in"]) || Number(grant["expires_in"]) <= 0)
            throw new Error();
          expiresAt = now() + Number(grant["expires_in"]) * 1000;
          if (!Number.isSafeInteger(expiresAt)) throw new Error();
        }
        await accounts.complete(
          binding,
          revision,
          { accessToken: grant["access_token"], expiresAt },
          signal,
        );
        return new Response(null, {
          status: 303,
          headers: {
            location: destination
              ? `${origin}/status/onboarding/${encodeURIComponent(destination.sessionId)}/${destination.generation}`
              : `${origin}/status/settings/account`,
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "set-cookie": cookie("", 0),
          },
        });
      } catch {
        return reply(
          {
            error:
              "GitHub connection could not be verified. Check membership and start sign-in again.",
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
function cookie(value: string, maxAge: number) {
  return `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
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
