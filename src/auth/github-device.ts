import { PAWS_GITHUB_OAUTH_CLIENT_ID } from "../config";
import {
  DEVICE_ACCESS_DENIED_MESSAGE,
  DEVICE_CODE_EXPIRED_MESSAGE,
  DEVICE_SCOPE,
  DEVICE_SCOPE_MESSAGE,
  GITHUB_REAUTH_MESSAGE,
  MISSING_GITHUB_CLIENT_ID_MESSAGE,
  WORKFLOW_SCOPE_NOTE,
} from "./messages";

export const DEVICE_CODE_URL = "https://github.com/login/device/code";
export const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_USER_URL = "https://api.github.com/user";

export type DeviceFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type DeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};

export type DeviceGrant = {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  scope: string;
};

export type GitHubAccount = {
  login: string;
  id: number;
  scopes: string;
};

export class DeviceFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceFlowError";
  }
}

/** Empty, or still the setup placeholder. Do not send this to GitHub. */
export function missingGitHubClientId(clientId: string | null | undefined): boolean {
  const trimmed = clientId?.trim() ?? "";
  return trimmed.length === 0 || trimmed === PAWS_GITHUB_OAUTH_CLIENT_ID;
}

/**
 * `PAWS_GITHUB_CLIENT_ID` wins when it is a real client id.
 * A placeholder falls through to `github.oauth_client_id`.
 */
export function resolveGitHubOAuthClientId(input: {
  env?: string | null;
  configured?: string | null;
}): string {
  const fromEnv = input.env?.trim() ?? "";
  const fromConfig = input.configured?.trim() ?? "";
  if (!missingGitHubClientId(fromEnv)) return fromEnv;
  if (!missingGitHubClientId(fromConfig)) return fromConfig;
  if (fromEnv.length > 0) return fromEnv;
  if (fromConfig.length > 0) return fromConfig;
  return PAWS_GITHUB_OAUTH_CLIENT_ID;
}

/**
 * GitHub's device flow.
 * The OAuth client id is public. No client secret is sent.
 * `workflow` is not part of {@link DEVICE_SCOPE}; see {@link WORKFLOW_SCOPE_NOTE}.
 */
export async function requestDeviceCode(input: {
  clientId: string;
  fetch: DeviceFetch;
  scope?: string;
}): Promise<DeviceCode> {
  if (missingGitHubClientId(input.clientId)) {
    throw new DeviceFlowError(MISSING_GITHUB_CLIENT_ID_MESSAGE);
  }
  const scope = input.scope ?? DEVICE_SCOPE;
  if (scope.split(/\s+/).includes("workflow")) {
    throw new DeviceFlowError(WORKFLOW_SCOPE_NOTE);
  }
  const response = await postForm(input.fetch, DEVICE_CODE_URL, {
    client_id: input.clientId.trim(),
    scope,
  });
  const body = await readJson(response);
  const deviceCode = readString(body, "device_code");
  const userCode = readString(body, "user_code");
  const verificationUri = readString(body, "verification_uri");
  const error = readString(body, "error");
  if (
    !response.ok ||
    error !== null ||
    deviceCode === null ||
    userCode === null ||
    verificationUri === null
  ) {
    throw new DeviceFlowError(deviceCodeFailure(response, body));
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresIn: readPositive(body, "expires_in") ?? 900,
    interval: readPositive(body, "interval") ?? 5,
  };
}

export async function pollDeviceToken(input: {
  clientId: string;
  deviceCode: string;
  fetch: DeviceFetch;
  intervalSeconds: number;
  expiresInSeconds: number;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<DeviceGrant> {
  const now = input.now ?? Date.now;
  let interval = Math.max(0, input.intervalSeconds);
  const deadline = now() + input.expiresInSeconds * 1000;
  for (;;) {
    await input.sleep(interval * 1000);
    if (now() > deadline) throw new DeviceFlowError(DEVICE_CODE_EXPIRED_MESSAGE);
    const response = await postForm(input.fetch, ACCESS_TOKEN_URL, {
      client_id: input.clientId,
      device_code: input.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (response.status === 401) throw new DeviceFlowError(GITHUB_REAUTH_MESSAGE);
    const body = await readJson(response);
    const error = readString(body, "error");
    if (error === null) return grantFrom(body);
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval += 5;
      continue;
    }
    if (error === "expired_token") throw new DeviceFlowError(DEVICE_CODE_EXPIRED_MESSAGE);
    if (error === "access_denied") throw new DeviceFlowError(DEVICE_ACCESS_DENIED_MESSAGE);
    throw new DeviceFlowError(`GitHub sign-in failed (${error}). ${GITHUB_REAUTH_MESSAGE}.`);
  }
}

export async function refreshDeviceToken(input: {
  clientId: string;
  refreshToken: string;
  fetch: DeviceFetch;
}): Promise<DeviceGrant> {
  const response = await postForm(input.fetch, ACCESS_TOKEN_URL, {
    client_id: input.clientId,
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  });
  if (response.status === 401) throw new DeviceFlowError(GITHUB_REAUTH_MESSAGE);
  const body = await readJson(response);
  const error = readString(body, "error");
  if (error !== null) {
    if (response.status === 401) throw new DeviceFlowError(GITHUB_REAUTH_MESSAGE);
    throw new DeviceFlowError(`GitHub token refresh failed (${error}). ${GITHUB_REAUTH_MESSAGE}.`);
  }
  if (response.status === 401) throw new DeviceFlowError(GITHUB_REAUTH_MESSAGE);
  return grantFrom(body);
}

/** `GET /user` plus `X-OAuth-Scopes`. Requires `repo` and `read:org`. */
export async function fetchGitHubAccount(input: {
  token: string;
  fetch: DeviceFetch;
  app?: boolean;
}): Promise<GitHubAccount> {
  const response = await input.fetch(GITHUB_USER_URL, {
    method: "GET",
    headers: githubHeaders(input.token),
  });
  if (response.status === 401) throw new DeviceFlowError(GITHUB_REAUTH_MESSAGE);
  if (!response.ok) {
    throw new DeviceFlowError(
      `GitHub user lookup failed (${response.status}). ${GITHUB_REAUTH_MESSAGE}.`,
    );
  }
  const scopes = response.headers.get("x-oauth-scopes") ?? "";
  if (!input.app && !scopesGrantRepoAndOrg(scopes)) throw new DeviceFlowError(DEVICE_SCOPE_MESSAGE);
  const body = await readJson(response);
  const login = readString(body, "login");
  const id = readPositive(body, "id");
  if (login === null || id === null) {
    throw new DeviceFlowError(`GitHub user lookup was incomplete. ${GITHUB_REAUTH_MESSAGE}.`);
  }
  return { login, id, scopes };
}

export function scopesGrantRepoAndOrg(header: string): boolean {
  const scopes = new Set(
    header
      .split(",")
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0),
  );
  return scopes.has("repo") && scopes.has("read:org");
}

export async function openVerificationPage(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const proc = Bun.spawn([command, url], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const timer = setTimeout(() => {
      proc.kill();
    }, 500);
    await proc.exited;
    clearTimeout(timer);
  } catch {
    // A missing browser is fine. The user code is already printed.
  }
}

async function postForm(
  fetchImpl: DeviceFetch,
  url: string,
  fields: Record<string, string>,
): Promise<Response> {
  const body = new URLSearchParams(fields);
  return fetchImpl(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
}

function grantFrom(body: unknown): DeviceGrant {
  const accessToken = readString(body, "access_token");
  if (accessToken === null || /\s/.test(accessToken)) {
    throw new DeviceFlowError(`GitHub did not return an access token. ${GITHUB_REAUTH_MESSAGE}.`);
  }
  const scope = readString(body, "scope") ?? "";
  if (!scopesGrantRepoAndOrg(scope.replaceAll(" ", ","))) {
    throw new DeviceFlowError(DEVICE_SCOPE_MESSAGE);
  }
  return {
    accessToken,
    refreshToken: readString(body, "refresh_token"),
    expiresIn: readPositive(body, "expires_in"),
    scope,
  };
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "paws",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** Device-code failures name GitHub's error and a fix. They do not say to log in again. */
function deviceCodeFailure(response: Response, body: unknown): string {
  const error = readString(body, "error");
  const description = readString(body, "error_description") ?? readString(body, "message");
  return `GitHub device-code error (${deviceErrorSummary(response, error, description)}). ${deviceErrorFix(error, response.status)}`;
}

function deviceErrorSummary(
  response: Response,
  error: string | null,
  description: string | null,
): string {
  if (error !== null) {
    const named = description !== null ? `${error}: ${description}` : error;
    if (response.status === 404) return `404 Not Found; ${named}`;
    return named;
  }
  if (response.status === 404) return "404 Not Found";
  const statusText = response.statusText.trim();
  const http = statusText.length > 0 ? `${response.status} ${statusText}` : String(response.status);
  if (description !== null && description.toLowerCase() !== statusText.toLowerCase()) {
    return `${http}: ${description}`;
  }
  return http;
}

function deviceErrorFix(error: string | null, status: number): string {
  if (error === "device_flow_disabled") return "Enable Device Flow on the OAuth App.";
  if (error === "unauthorized_client") {
    return "Enable Device Flow on the OAuth App and check the client id.";
  }
  if (error === "incorrect_client_credentials" || error === "not_found" || status === 404) {
    return "Check the client id.";
  }
  return "Check the client id and enable Device Flow on the OAuth App.";
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  return parseOAuthBody(text, response.headers.get("content-type"));
}

function parseOAuthBody(text: string, contentType: string | null): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return {};
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return { message: clip(trimmed) };
    }
  }
  const type = contentType ?? "";
  if (type.includes("application/x-www-form-urlencoded") || isFormBody(trimmed)) {
    const params = new URLSearchParams(trimmed);
    const record: Record<string, string> = {};
    for (const [key, value] of params) {
      if (record[key] === undefined) record[key] = value;
    }
    if (Object.keys(record).length > 0) return record;
  }
  return { message: clip(trimmed) };
}

function isFormBody(text: string): boolean {
  return /^[A-Za-z0-9_]+=/.test(text) && !text.includes("<");
}

function clip(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 180 ? `${one.slice(0, 180)}…` : one;
}

function readString(body: unknown, key: string): string | null {
  if (!isRecord(body)) return null;
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readPositive(body: unknown, key: string): number | null {
  if (!isRecord(body)) return null;
  const value = body[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return null;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
