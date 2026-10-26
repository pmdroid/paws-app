import { journalCaught } from "../journal";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  attributionReturnPath,
  beginGitHubAttribution,
  consumeGitHubAttributionRequest,
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
const NOT_CONFIGURED =
  "Ask the Paws operator to configure the GitHub App on the server, then restart Paws.";

export function createGitHubAttributionLink(options: {
  db: Database;
  origin: string;
  client?: { clientId: string; clientSecret: string };
  refresh: (workspaceId: string, userId: string) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const http = options.fetch ?? fetch;
  const origin = new URL(options.origin).origin;
  if (options.client && (!options.client.clientId || !options.client.clientSecret))
    throw new Error("Configured GitHub App client metadata is required.");
  /** Records one pending link and builds GitHub's authorize address for it. */
  function begin(
    client: { clientId: string; clientSecret: string },
    binding: AttributionBinding,
    returnPath?: string,
  ) {
    const state = workspaceSecret();
    const browser = workspaceSecret();
    beginGitHubAttribution(options.db, binding, {
      stateHash: workspaceTokenHash(state),
      browserHash: workspaceTokenHash(browser),
      now: now(),
      ...(returnPath === undefined ? {} : { returnPath }),
    });
    const target = new URL("https://github.com/login/oauth/authorize");
    target.search = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: `${origin}${CALLBACK}`,
      state,
      code_challenge: createHash("sha256").update(verifier(browser, state)).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    return {
      authorizeUrl: target.href,
      cookie: `${COOKIE}=${browser}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
    };
  }
  return {
    /** The page offers the link only when the server has GitHub App client metadata. */
    configured: options.client !== undefined,
    /**
     * Starts a consented link from a server-rendered page form (the onboarding page). The caller
     * decides `returnPath` from the route it verified; nothing in the request names it. The form
     * carries the session's CSRF token and the consent box, and the answer is a redirect to GitHub.
     */
    async startFromPage(request: Request, returnPath: string): Promise<Response> {
      const url = new URL(request.url);
      if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405);
      if (attributionReturnPath(returnPath) !== returnPath)
        throw new Error("GitHub credit can only return to Settings or an onboarding page.");
      if (
        url.origin !== origin ||
        request.headers.get("origin") !== origin ||
        (request.headers.has("host") &&
          request.headers.get("host")?.toLowerCase() !== url.host.toLowerCase())
      )
        return reply({ error: "Use the configured Paws origin." }, 403);
      let access = requestWorkspaceSession(options.db, request, now());
      if (!access) return reply({ error: "Sign in to Paws." }, 401);
      const form = await readForm(request).catch((caughtError1) => {
        journalCaught(caughtError1, "github-attribution.startFromPage.readForm", null);
        return null;
      });
      if (form === null || !sameSecret(form.get("csrf"), access.session.csrfToken))
        return reply({ error: "CSRF token required." }, 403);
      if (form.get("consent") !== "yes")
        return reply(
          { error: "Explicit consent to public commit and pull request attribution is required." },
          400,
        );
      if (!options.client) return reply({ error: NOT_CONFIGURED }, 503);
      const binding: AttributionBinding = {
        workspaceId: access.principal.workspaceId,
        userId: access.principal.userId,
        sessionHash: access.session.tokenHash,
      };
      try {
        await options.refresh(binding.workspaceId, binding.userId);
        access = requestWorkspaceSession(options.db, request, now());
        if (
          !access ||
          access.session.tokenHash !== binding.sessionHash ||
          access.principal.workspaceId !== binding.workspaceId ||
          access.principal.role === "observer"
        )
          throw new Error("Session changed.");
        requireAttributionSession(options.db, binding, now());
        const started = begin(options.client, binding, returnPath);
        return new Response(null, {
          status: 303,
          headers: {
            location: started.authorizeUrl,
            "set-cookie": started.cookie,
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          },
        });
      } catch (caughtError2) {
        journalCaught(caughtError2, "github-attribution.startFromPage.refresh", null);
        return reply(
          {
            error: "GitHub attribution could not be verified. Check membership and sign in again.",
          },
          403,
        );
      }
    },
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
        if (access.principal.role === "observer") throw new Error("Membership is required.");
        if (url.pathname === PATH && request.method === "GET")
          return reply({
            configured: options.client !== undefined,
            identity: githubAttribution(options.db, binding.workspaceId, binding.userId),
          });
        requireAttributionSession(options.db, binding, now());
        if (url.pathname === PATH) {
          if (request.method === "DELETE") {
            revokeGitHubAttribution(options.db, binding, now());
            return reply({ ok: true });
          }
          if (!options.client) return reply({ error: NOT_CONFIGURED }, 503);
          const body = await readWorkspaceJson(request);
          if (!record(body) || Object.keys(body).length !== 1 || body["consent"] !== true)
            return reply(
              {
                error:
                  "Explicit consent to public commit and pull request attribution is required.",
              },
              400,
            );
          const started = begin(options.client, binding);
          return reply({ authorizeUrl: started.authorizeUrl }, 200, {
            "set-cookie": started.cookie,
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
        const { revision, returnPath } = consumeGitHubAttributionRequest(options.db, binding, {
          stateHash: workspaceTokenHash(state),
          browserHash: workspaceTokenHash(browser),
          now: now(),
        });
        if (!options.client) return reply({ error: NOT_CONFIGURED }, 503);
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
            // Stored when the link started; checked against the allow-list once more here.
            location: `${origin}${attributionReturnPath(returnPath)}`,
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "set-cookie": `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
          },
        });
      } catch (caughtError3) {
        journalCaught(caughtError3, "github-attribution.handle.refresh", null);
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
function sameSecret(received: string | null, expected: string): boolean {
  const a = Buffer.from(received ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
/** A small `application/x-www-form-urlencoded` body from a page form. */
async function readForm(request: Request): Promise<URLSearchParams> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/x-www-form-urlencoded"
  )
    throw new Error("Expected a form.");
  const reader = request.body?.getReader();
  if (reader === undefined) throw new Error("Missing body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
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
