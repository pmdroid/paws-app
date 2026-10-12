import {
  fetchGitHubAccount,
  openVerificationPage,
  pollDeviceToken,
  refreshDeviceToken,
  requestDeviceCode,
  resolveGitHubOAuthClientId,
  type DeviceCode,
  type DeviceFetch,
  type DeviceGrant,
} from "./github-device";
import { DEVICE_CODE_EXPIRED_MESSAGE, GITHUB_REAUTH_MESSAGE } from "./messages";
import { createTokenStore, type GitHubTokenStore, type StoredGitHubOAuth } from "./store";
import { loginGitHubApp } from "./github-app";
import { loadRuntime } from "../config";

export type LoginIO = {
  signal?: AbortSignal;
  auth?: "oauth" | "gh" | "app";
  repo?: string | null;
  port?: number;
  timeoutMs?: number;
  home?: string;
  env?: Record<string, string | undefined>;
  oauthClientId?: string | null;
  fetch?: DeviceFetch;
  store?: GitHubTokenStore;
  stdout?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  openBrowser?: (url: string) => Promise<void>;
  now?: () => number;
};

const RESTARTS = 1;

export async function loginGitHub(options: LoginIO = {}): Promise<{ login: string; id: number }> {
  const store = storeFor(options);
  const stdout = options.stdout ?? ((line: string) => console.log(line));
  const user =
    options.auth === "app"
      ? await loginGitHubApp({ ...options, store, stdout })
      : await completeLogin({ ...options, store, stdout });
  stdout(`Signed in as ${user.login}`);
  const warning = store.warning;
  if (warning !== null) stdout(warning);
  return user;
}

export async function logoutGitHub(options: LoginIO = {}): Promise<void> {
  await storeFor(options).delete();
}

/**
 * Starts the device flow and finishes it in the background.
 * The returned code is what the dashboard shows while polling completes.
 */
export async function beginGitHubDevice(options: LoginIO = {}): Promise<{
  userCode: string;
  verificationUri: string;
  completed: Promise<{ login: string; id: number }>;
}> {
  const first = await requestDeviceCode({ clientId: clientId(options), fetch: fetchOf(options) });
  announce(options, first);
  await (options.openBrowser ?? openVerificationPage)(first.verificationUri).catch(() => undefined);
  const completed = completeFrom(options, first, 0);
  return {
    userCode: first.userCode,
    verificationUri: first.verificationUri,
    completed,
  };
}

export function createDashboardGitHubAuth(options: LoginIO = {}): {
  user(): Promise<{ login: string; id: number } | null>;
  beginDevice(): Promise<{
    userCode: string;
    verificationUri: string;
    completed: Promise<{ login: string; id: number }>;
  }>;
} {
  return {
    user: () => readSignedInUser(options),
    async beginDevice() {
      const runtime = loadRuntime({
        ...(options.env ?? process.env),
        ...(options.home ? { PAWS_HOME: options.home } : {}),
      });
      if ((options.auth ?? runtime.githubAuth) !== "app")
        return beginGitHubDevice({
          ...options,
          home: runtime.env.home,
          env: options.env ?? process.env,
          oauthClientId:
            options.oauthClientId ?? runtime.file.oauthClientId ?? runtime.oauthClientId,
        });
      const started = Promise.withResolvers<string>();
      const completed = loginGitHubApp({
        ...options,
        home: runtime.env.home,
        repo: options.repo ?? runtime.repo,
        openBrowser: async (url) => {
          started.resolve(url);
        },
      });
      void completed.catch((error) => started.reject(error));
      return { userCode: "", verificationUri: await started.promise, completed };
    },
  };
}

export async function readSignedInUser(
  options: LoginIO = {},
): Promise<{ login: string; id: number } | null> {
  const stored = await storeFor(options).load();
  if (stored === null || stored.invalid) return null;
  return { login: stored.login, id: stored.id };
}

export function resolveOAuthClientId(options: LoginIO = {}): string {
  return clientId(options);
}

async function completeLogin(options: LoginIO): Promise<{ login: string; id: number }> {
  const fetchImpl = fetchOf(options);
  const id = clientId(options);
  let device = await requestDeviceCode({ clientId: id, fetch: fetchImpl });
  announce(options, device);
  await (options.openBrowser ?? openVerificationPage)(device.verificationUri).catch(
    () => undefined,
  );
  return completeFrom(options, device, 0);
}

async function completeFrom(
  options: LoginIO,
  device: DeviceCode,
  restarts: number,
): Promise<{ login: string; id: number }> {
  const fetchImpl = fetchOf(options);
  const id = clientId(options);
  try {
    const grant = await pollDeviceToken({
      clientId: id,
      deviceCode: device.deviceCode,
      fetch: fetchImpl,
      intervalSeconds: device.interval,
      expiresInSeconds: device.expiresIn,
      sleep: options.sleep ?? delay,
      ...(options.now ? { now: options.now } : {}),
    });
    return saveGrant(options, grant);
  } catch (error) {
    if (restarts < RESTARTS && isExpired(error)) {
      const next = await requestDeviceCode({ clientId: id, fetch: fetchImpl });
      announce(options, next);
      await (options.openBrowser ?? openVerificationPage)(next.verificationUri).catch(
        () => undefined,
      );
      return completeFrom(options, next, restarts + 1);
    }
    throw error;
  }
}

async function saveGrant(
  options: LoginIO,
  grant: DeviceGrant,
): Promise<{ login: string; id: number }> {
  const account = await fetchGitHubAccount({ token: grant.accessToken, fetch: fetchOf(options) });
  const now = options.now ?? Date.now;
  const stored: StoredGitHubOAuth = {
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    expiresAtMs: grant.expiresIn === null ? null : now() + grant.expiresIn * 1000,
    scope: account.scopes || grant.scope,
    login: account.login,
    id: account.id,
    invalid: false,
  };
  await storeFor(options).save(stored);
  return { login: account.login, id: account.id };
}

export async function refreshStoredToken(
  options: LoginIO,
  stored: StoredGitHubOAuth,
): Promise<StoredGitHubOAuth> {
  if (stored.refreshToken === null) throw new Error(GITHUB_REAUTH_MESSAGE);
  try {
    const grant = await refreshDeviceToken({
      clientId: clientId(options),
      refreshToken: stored.refreshToken,
      fetch: fetchOf(options),
    });
    const now = options.now ?? Date.now;
    const next: StoredGitHubOAuth = {
      ...stored,
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken ?? stored.refreshToken,
      expiresAtMs: grant.expiresIn === null ? stored.expiresAtMs : now() + grant.expiresIn * 1000,
      scope: grant.scope || stored.scope,
      invalid: false,
    };
    await storeFor(options).save(next);
    return next;
  } catch (error) {
    if (isReauth(error)) {
      await storeFor(options).markInvalid();
      throw new Error(GITHUB_REAUTH_MESSAGE, { cause: error });
    }
    throw error;
  }
}

function announce(options: LoginIO, device: DeviceCode): void {
  const stdout = options.stdout;
  stdout?.(`Enter code ${device.userCode} at ${device.verificationUri}`);
}

function storeFor(options: LoginIO): GitHubTokenStore {
  if (options.store) return options.store;
  const home = options.home ?? options.env?.PAWS_HOME ?? defaultHome();
  return createTokenStore({ home });
}

function clientId(options: LoginIO): string {
  return resolveGitHubOAuthClientId({
    env: options.env?.PAWS_GITHUB_CLIENT_ID,
    configured: options.oauthClientId,
  });
}

function fetchOf(options: LoginIO): DeviceFetch {
  return options.fetch ?? ((input, init) => fetch(input, init));
}

function defaultHome(): string {
  const fromEnv = process.env.PAWS_HOME?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return `${process.env.HOME ?? ""}/.paws`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isExpired(error: unknown): boolean {
  return error instanceof Error && error.message === DEVICE_CODE_EXPIRED_MESSAGE;
}

function isReauth(error: unknown): boolean {
  return error instanceof Error && error.message === GITHUB_REAUTH_MESSAGE;
}
