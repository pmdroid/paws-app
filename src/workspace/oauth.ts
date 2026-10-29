import { createHash, createHmac } from "node:crypto";
import type { Database } from "bun:sqlite";
import { consumeWorkspaceOAuthRequest, saveWorkspaceOAuthRequest } from "../db";
import { cookieValue, workspaceSecret, workspaceTokenHash } from "./session";

const LOGIN_COOKIE = "__Host-paws-login";

export type LinearBrowserIdentity = {
  userId: string;
  organizationId: string;
  organizationName: string;
  name: string;
  email: string;
  admin: boolean;
  active: boolean;
  guest: boolean;
};

export function beginWorkspaceOAuth(
  db: Database,
  options: {
    clientId: string;
    origin: string;
    now: number;
    bootstrap: string | null;
    assignmentHash?: string | null;
  },
): Response {
  const state = workspaceSecret();
  const browser = workspaceSecret();
  const verifier = pkceVerifier(browser, state);
  if (
    !saveWorkspaceOAuthRequest(db, {
      stateHash: workspaceTokenHash(state),
      browserHash: workspaceTokenHash(browser),
      bootstrapHash: options.bootstrap === null ? null : workspaceTokenHash(options.bootstrap),
      expiresAt: options.now + 10 * 60_000,
      assignmentHash: options.assignmentHash,
    })
  )
    return Response.json(
      { error: "Too many sign-in attempts. Try again later." },
      { status: 429, headers: { "cache-control": "no-store", "retry-after": "60" } },
    );
  const target = new URL("https://linear.app/oauth/authorize");
  target.search = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: `${options.origin}/auth/linear/callback`,
    response_type: "code",
    actor: "user",
    scope: "read",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return new Response(null, {
    status: 303,
    headers: {
      location: target.href,
      "set-cookie": `${LOGIN_COOKIE}=${browser}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

export async function completeWorkspaceOAuth(
  db: Database,
  request: Request,
  options: { clientId: string; origin: string; now: number; fetch: typeof fetch },
): Promise<{
  identity: LinearBrowserIdentity;
  bootstrapHash: string | null;
  assignmentHash: string | null;
}> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const browser = cookieValue(request, LOGIN_COOKIE);
  if (
    state === null ||
    browser === null ||
    !/^[A-Za-z0-9_-]{43}$/.test(state) ||
    !/^[A-Za-z0-9_-]{43}$/.test(browser)
  )
    throw new Error("The Linear sign-in request is invalid or expired.");
  const pending = consumeWorkspaceOAuthRequest(
    db,
    workspaceTokenHash(state),
    workspaceTokenHash(browser),
    options.now,
  );
  if (pending === null) throw new Error("The Linear sign-in request is invalid or expired.");
  const code = url.searchParams.get("code");
  if (url.searchParams.has("error") || code === null || code === "" || code.length > 4096)
    throw new Error("Linear sign-in was not completed.");
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
  const exchange = await options.fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    signal,
    redirect: "error",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: options.clientId,
      redirect_uri: `${options.origin}/auth/linear/callback`,
      grant_type: "authorization_code",
      code,
      code_verifier: pkceVerifier(browser, state),
    }),
  });
  const token: unknown = await exchange.json();
  if (
    !exchange.ok ||
    !record(token) ||
    typeof token["access_token"] !== "string" ||
    token["access_token"] === "" ||
    /\s/.test(token["access_token"])
  )
    throw new Error("Linear sign-in could not be verified.");
  const response = await options.fetch("https://api.linear.app/graphql", {
    method: "POST",
    signal,
    redirect: "error",
    headers: {
      authorization: `Bearer ${token["access_token"]}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query:
        "query PawsBrowserIdentity { viewer { id name email app admin active guest organization { id name } } }",
    }),
  });
  const body: unknown = await response.json();
  if (
    !response.ok ||
    !record(body) ||
    body["errors"] !== undefined ||
    !record(body["data"]) ||
    !record(body["data"]["viewer"])
  )
    throw new Error("Linear sign-in could not be verified.");
  const viewer = body["data"]["viewer"];
  const organization = viewer["organization"];
  if (viewer["app"] !== false || !record(organization))
    throw new Error("A Linear user account is required.");
  return {
    identity: {
      userId: text(viewer, "id"),
      name: text(viewer, "name"),
      email: text(viewer, "email"),
      admin: viewer["admin"] === true,
      active: viewer["active"] === true,
      guest: viewer["guest"] !== false,
      organizationId: text(organization, "id"),
      organizationName: text(organization, "name"),
    },
    bootstrapHash: pending.bootstrapHash,
    assignmentHash: pending.assignmentHash ?? null,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || result.trim() === "" || result.length > 1024)
    throw new Error("Linear returned incomplete user identity.");
  return result;
}

function pkceVerifier(browser: string, state: string): string {
  return createHmac("sha256", browser).update(state).digest("base64url");
}
