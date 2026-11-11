import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { readSecretFile, writeSecretFile } from "../credentials";
import { githubAttribution, type Db } from "../db";
import { journalCaught } from "../journal";

type StoredGrant = {
  githubId: number;
  accessToken: string;
  accessExpiresAt: number | null;
  refreshToken: string | null;
  refreshExpiresAt: number | null;
};

const REFRESH_MARGIN_MS = 5 * 60_000;
const UNKEPT = "GitHub did not return a user token Paws can keep.";

export function createGitHubUserGrants(options: {
  store: Db;
  secretsDir: string;
  client: { clientId: string; clientSecret: string };
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const http = options.fetch ?? fetch;
  const queues = new Map<string, Promise<void>>();
  const unsaved = new Map<string, string>();
  function serial<T>(workspaceId: string, userId: string, run: () => Promise<T>): Promise<T> {
    const key = `${workspaceId}\0${userId}`;
    const next = (queues.get(key) ?? Promise.resolve()).then(run);
    const settled = () => undefined;
    const tail = next.then(settled, settled);
    queues.set(key, tail);
    void tail.then(() => queues.get(key) === tail && queues.delete(key));
    return next;
  }
  const file = (workspaceId: string, userId: string) =>
    join(
      options.secretsDir,
      `github-user-grant-${createHash("sha256").update(`${workspaceId}\0${userId}`).digest("hex")}.grant`,
    );
  function save(workspaceId: string, userId: string, grant: StoredGrant) {
    const key = `${workspaceId}\0${userId}`;
    unsaved.set(key, JSON.stringify(grant));
    try {
      writeSecretFile(file(workspaceId, userId), unsaved.get(key)!);
      unsaved.delete(key);
    } catch (caught) {
      journalCaught(caught, "github-user-grant.save", null, "kept in memory until the next save");
    }
    return grant.accessToken;
  }
  function clear(workspaceId: string, userId: string) {
    unsaved.delete(`${workspaceId}\0${userId}`);
    rmSync(file(workspaceId, userId), { force: true });
  }
  async function usable(workspaceId: string, userId: string) {
    let grant: StoredGrant | null;
    try {
      const text =
        unsaved.get(`${workspaceId}\0${userId}`) ??
        readSecretFile(file(workspaceId, userId), false);
      if (text === null) return null;
      grant = storedGrant(JSON.parse(text) as StoredGrant);
    } catch (caught) {
      journalCaught(caught, "github-user-grant.read", null, "damaged grant is cleared");
      grant = null;
    }
    const identity = grant && (await githubAttribution(options.store, workspaceId, userId));
    const fresh =
      grant?.accessExpiresAt === null || (grant?.accessExpiresAt ?? 0) - now() >= REFRESH_MARGIN_MS;
    if (!grant || identity?.id !== grant.githubId || (!fresh && !grant.refreshToken)) {
      clear(workspaceId, userId);
      return null;
    }
    return { grant, fresh };
  }
  async function token(workspaceId: string, userId: string): Promise<string | null> {
    const { grant, fresh } = (await usable(workspaceId, userId)) ?? {};
    if (!grant || fresh) return grant?.accessToken ?? null;
    let response: Response;
    let body: unknown;
    try {
      response = await http("https://github.com/login/oauth/access_token", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: options.client.clientId,
          client_secret: options.client.clientSecret,
          grant_type: "refresh_token",
          refresh_token: grant.refreshToken!,
        }),
      });
      body = await response.json();
    } catch (caught) {
      journalCaught(caught, "github-user-grant.refresh", null);
      return null;
    }
    const refused = "error" in Object(body) && response.status < 500 && response.status !== 429;
    if (!refused && !response.ok) return null;
    const refreshed = refused ? null : parseGrant(grant.githubId, body, now());
    if (refreshed !== null) return save(workspaceId, userId, refreshed);
    if (!refused) journalCaught(new Error(UNKEPT), "github-user-grant.refresh", null);
    clear(workspaceId, userId);
    return null;
  }
  return {
    link(
      workspaceId: string,
      userId: string,
      githubId: number,
      body: unknown,
      saveIdentity: () => Promise<void>,
    ) {
      const grant = parseGrant(githubId, body, now());
      if (grant === null) journalCaught(new Error(UNKEPT), "github-user-grant.link", null);
      return serial(workspaceId, userId, async () => {
        await saveIdentity();
        if (grant !== null) save(workspaceId, userId, grant);
      });
    },
    clear: (workspaceId: string, userId: string) =>
      serial(workspaceId, userId, async () => clear(workspaceId, userId)),
    enabled: (workspaceId: string, userId: string) =>
      serial(workspaceId, userId, async () => (await usable(workspaceId, userId)) !== null),
    token: (workspaceId: string, userId: string) =>
      serial(workspaceId, userId, () => token(workspaceId, userId)),
  };
}

function storedGrant(grant: StoredGrant): StoredGrant | null {
  const time = (at: unknown) => at === null || Number.isFinite(at);
  return Number.isSafeInteger(grant.githubId) &&
    /^ghu_\w+$/.test(grant.accessToken) &&
    (grant.refreshToken === null || /^ghr_\w+$/.test(grant.refreshToken)) &&
    time(grant.accessExpiresAt) &&
    time(grant.refreshExpiresAt)
    ? grant
    : null;
}

function parseGrant(githubId: number, body: unknown, at: number): StoredGrant | null {
  if (body === null || typeof body !== "object") return null;
  const grant = body as Record<string, unknown>;
  const access = grant["access_token"];
  const refresh = grant["refresh_token"];
  if (typeof access !== "string" || !/^ghu_\w+$/.test(access)) return null;
  if (refresh !== undefined && !/^ghr_\w+$/.test(String(refresh))) return null;
  const expiry = (seconds: unknown) =>
    typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
      ? at + seconds * 1000
      : null;
  return {
    githubId,
    accessToken: access,
    accessExpiresAt: expiry(grant["expires_in"]),
    refreshToken: refresh === undefined ? null : String(refresh),
    refreshExpiresAt: refresh === undefined ? null : expiry(grant["refresh_token_expires_in"]),
  };
}
