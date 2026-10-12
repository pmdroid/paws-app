import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { readSecretFile, writeSecretFile, refreshCredential } from "../credentials";

/** Scopes for an install that can be delegated and mentioned. */
export const LINEAR_APP_SCOPES = "read,write,app:assignable,app:mentionable";

/** OAuth actor for the Paws app user. Install with this, not a user actor. */
export const LINEAR_ACTOR = "app" as const;

const TOKEN_URL = "https://api.linear.app/oauth/token";
const AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const REFRESH_SKEW_MS = 60_000;

export type EnvSource = Record<string, string | undefined>;

export type LinearEnv = {
  clientId: string | null;
  clientSecret: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  ngrokAuthtoken: string | null;
  noTunnel: boolean;
  /** `linear.webhooks`. Off unless `LINEAR_WEBHOOKS` is `1` or `true`. */
  webhooks: boolean;
  /** Team id or key. `LINEAR_TEAM_ID`, then `LINEAR_TEAM`. */
  teamId: string | null;
  /** App user id, used when a poll page has no `viewer`. */
  appUserId: string | null;
};

export type StoredLinearToken = {
  accessToken: string;
  refreshToken: string | null;
  expiresAtMs: number;
  scope: string | null;
  actor: typeof LINEAR_ACTOR;
};

export type LinearAuth = {
  hasToken(): boolean;
  assertAuthorized?(): void;
  ensureFresh(): Promise<string>;
  forceRefresh(): Promise<string>;
};

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Linear OAuth app settings this process expects:
 * actor=app, scopes read + write + app:assignable + app:mentionable.
 * Intake is polling. Webhooks are optional (`LINEAR_WEBHOOKS=true`).
 */

/** Doctor (QM-20) skips webhook, public URL, and ngrok checks while this is false. */
export function webhookChecksNeeded(source: EnvSource = process.env): boolean {
  return readLinearEnv(source).webhooks;
}
export function linearAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: string;
  codeChallenge?: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scopes ?? LINEAR_APP_SCOPES);
  url.searchParams.set("actor", LINEAR_ACTOR);
  url.searchParams.set("state", input.state);
  url.searchParams.set("prompt", "consent");
  if (input.codeChallenge) {
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

export function readLinearEnv(source: EnvSource): LinearEnv {
  const noTunnel = source["PAWS_NO_TUNNEL"];
  return {
    clientId: optional(source, "LINEAR_CLIENT_ID"),
    clientSecret: optional(source, "LINEAR_CLIENT_SECRET"),
    accessToken: optional(source, "LINEAR_ACCESS_TOKEN"),
    refreshToken: optional(source, "LINEAR_REFRESH_TOKEN"),
    ngrokAuthtoken: optional(source, "NGROK_AUTHTOKEN"),
    noTunnel: noTunnel === "1" || noTunnel === "true",
    webhooks: flag(source, "LINEAR_WEBHOOKS"),
    teamId: optional(source, "LINEAR_TEAM_ID") ?? optional(source, "LINEAR_TEAM"),
    appUserId: optional(source, "LINEAR_APP_USER_ID"),
  };
}

export function createLinearAuth(options: {
  db?: Database;
  tokenPath: string;
  clientId: string | null;
  clientSecret: string | null;
  bootstrapAccessToken?: string | null;
  bootstrapRefreshToken?: string | null;
  isAuthorized?: () => boolean;
  fetch?: FetchLike;
  now?: () => number;
}): LinearAuth {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  if (!existsSync(options.tokenPath)) {
    const accessToken = options.bootstrapAccessToken ?? null;
    if (accessToken !== null) {
      writeToken(options.tokenPath, {
        accessToken,
        refreshToken: options.bootstrapRefreshToken ?? null,
        expiresAtMs: options.bootstrapRefreshToken ? 0 : now() + 23 * 60 * 60 * 1000,
        scope: LINEAR_APP_SCOPES,
        actor: LINEAR_ACTOR,
      });
    }
  }
  const assertAuthorized = () => {
    if (options.isAuthorized?.() === false)
      throw new Error("Linear app access was revoked. Reconnect Linear in Paws.");
  };
  let pending: Promise<string> | null = null;

  async function refresh(): Promise<string> {
    assertAuthorized();
    if (pending !== null) return pending;
    pending = refreshOnce().finally(() => {
      pending = null;
    });
    return pending;
  }

  async function refreshOnce(): Promise<string> {
    assertAuthorized();
    const current = readToken(options.tokenPath);
    if (current?.refreshToken == null) {
      throw new Error("Linear access token expired and no refresh token is stored");
    }
    const rotate = async (
      token: StoredLinearToken,
      signal: AbortSignal,
    ): Promise<StoredLinearToken> => {
      assertAuthorized();
      const saved = await refreshLinearToken({
        refreshToken: token.refreshToken!,
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        fetch: (url, init) => fetchImpl(url, { ...init, signal }),
        now: now(),
      });
      assertAuthorized();
      if (saved.refreshToken === null)
        throw new Error("Linear refresh response has no refresh token");
      return saved;
    };
    if (options.db) {
      const saved = await refreshCredential({
        db: options.db,
        identity: options.tokenPath,
        read: () => readToken(options.tokenPath),
        write: (token) => {
          assertAuthorized();
          writeToken(options.tokenPath, token);
        },
        refresh: rotate,
      });
      assertAuthorized();
      return saved.accessToken;
    }
    const saved = await rotate(current, AbortSignal.timeout(15_000));
    assertAuthorized();
    writeToken(options.tokenPath, saved);
    return saved.accessToken;
  }

  return {
    assertAuthorized,
    hasToken() {
      return readToken(options.tokenPath) !== null;
    },
    async ensureFresh() {
      assertAuthorized();
      const current = readToken(options.tokenPath);
      if (current === null) throw new Error("Linear OAuth token is not configured");
      if (current.expiresAtMs - REFRESH_SKEW_MS > now()) return current.accessToken;
      if (current.refreshToken === null) {
        if (current.expiresAtMs > now()) return current.accessToken;
        throw new Error("Linear access token expired and no refresh token is stored");
      }
      return refresh();
    },
    forceRefresh() {
      return refresh();
    },
  };
}

export async function exchangeLinearCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier?: string;
  fetch?: FetchLike;
  now?: number;
}): Promise<StoredLinearToken> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  });
  if (input.codeVerifier) body.set("code_verifier", input.codeVerifier);
  return requestToken(body, input.fetch ?? fetch, input.now ?? Date.now());
}

export async function refreshLinearToken(input: {
  refreshToken: string;
  clientId: string | null;
  clientSecret: string | null;
  fetch?: FetchLike;
  now?: number;
}): Promise<StoredLinearToken> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  });
  if (input.clientId !== null) body.set("client_id", input.clientId);
  if (input.clientSecret !== null) body.set("client_secret", input.clientSecret);
  return requestToken(body, input.fetch ?? fetch, input.now ?? Date.now());
}

async function requestToken(
  body: URLSearchParams,
  fetchImpl: FetchLike,
  now: number,
): Promise<StoredLinearToken> {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error(`Linear token request failed (HTTP ${response.status})`);
  }
  const json: unknown = await response.json();
  if (!isRecord(json)) throw new Error("Linear token response was not an object");
  const accessToken = json["access_token"];
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("Linear token response did not include an access token");
  }
  const refreshToken = json["refresh_token"];
  const expiresIn = json["expires_in"];
  const expiresAtMs =
    typeof expiresIn === "number" && Number.isFinite(expiresIn)
      ? now + expiresIn * 1000
      : now + 23 * 60 * 60 * 1000;
  return {
    accessToken,
    refreshToken: typeof refreshToken === "string" && refreshToken.length > 0 ? refreshToken : null,
    expiresAtMs,
    scope: readScope(json["scope"]),
    actor: LINEAR_ACTOR,
  };
}

export function readStoredToken(path: string): StoredLinearToken | null {
  return readToken(path);
}

export function writeStoredToken(path: string, token: StoredLinearToken): void {
  writeToken(path, token);
}

function readToken(path: string): StoredLinearToken | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readSecretFile(path)!);
  } catch {
    throw new Error("Linear token file is unreadable");
  }
  if (!isRecord(parsed)) throw new Error("Linear token file is unreadable");
  const accessToken = parsed["accessToken"];
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("Linear token file is unreadable");
  }
  const refreshToken = parsed["refreshToken"];
  const expiresAtMs = parsed["expiresAtMs"];
  const scope = parsed["scope"];
  return {
    accessToken,
    refreshToken: typeof refreshToken === "string" && refreshToken.length > 0 ? refreshToken : null,
    expiresAtMs: typeof expiresAtMs === "number" && Number.isFinite(expiresAtMs) ? expiresAtMs : 0,
    scope: typeof scope === "string" ? scope : null,
    actor: LINEAR_ACTOR,
  };
}

function writeToken(path: string, token: StoredLinearToken): void {
  writeSecretFile(path, JSON.stringify(token));
}

function readScope(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.join(",");
  }
  return null;
}

function optional(source: EnvSource, key: string): string | null {
  const value = source[key];
  if (value === undefined || value.length === 0) return null;
  return value;
}

function flag(source: EnvSource, key: string): boolean {
  const value = source[key];
  return value === "1" || value === "true";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
