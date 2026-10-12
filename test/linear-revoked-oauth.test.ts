import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { isLinearAppRevoked, recordLinearInstallation, revokeLinearInstallation } from "../src/db";
import {
  createLinearAuth,
  createLinearClient,
  linearTokenPath,
  openLinear,
  readStoredToken,
  writeStoredToken,
  type StoredLinearToken,
} from "../src/linear";
import { tempDb, tempHome } from "./helpers";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };
function fixture() {
  const db = tempDb();
  cleanup.push(() => db.close());
  recordLinearInstallation(db, { ...scope, sessionId: "session", teamId: "team", observedAtMs: 1 });
  const home = tempHome();
  const path = linearTokenPath(join(home, "secrets"));
  const token: StoredLinearToken = {
    accessToken: "fake-old-access",
    refreshToken: "fake-old-refresh",
    expiresAtMs: Date.now() + 600_000,
    scope: "read,write",
    actor: "app",
  };
  writeStoredToken(path, token);
  const revoke = () =>
    revokeLinearInstallation(db, { ...scope, eventKey: "revoked", createdAtMs: 2 });
  return { db, home, path, token, revoke, allowed: () => !isLinearAppRevoked(db, scope) };
}

test("known revocation blocks fresh credentials and refresh without a network request", async () => {
  const f = fixture();
  let requests = 0;
  const auth = createLinearAuth({
    db: f.db,
    tokenPath: f.path,
    clientId: "client",
    clientSecret: "fake-secret",
    isAuthorized: f.allowed,
    fetch: async () => {
      requests++;
      throw new Error("Offline request must not run");
    },
  });
  f.revoke();
  expect(auth.hasToken()).toBe(true);
  await expect(auth.ensureFresh()).rejects.toThrow("revoked");
  await expect(auth.forceRefresh()).rejects.toThrow("revoked");
  expect(requests).toBe(0);
  expect(readStoredToken(f.path)).toEqual(f.token);
});

test.each([false, true])(
  "revocation fences a pending refresh and preserves operator replacement=%s",
  async (replace) => {
    const f = fixture();
    writeStoredToken(f.path, { ...f.token, expiresAtMs: 0 });
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<Response>();
    let requests = 0;
    const auth = createLinearAuth({
      db: f.db,
      tokenPath: f.path,
      clientId: "client",
      clientSecret: "fake-secret",
      isAuthorized: f.allowed,
      fetch: async () => {
        requests++;
        started.resolve();
        return released.promise;
      },
    });
    const pending = auth.ensureFresh();
    await started.promise;
    f.revoke();
    const expected = replace
      ? { ...f.token, accessToken: "fake-operator-access", refreshToken: "fake-operator-refresh" }
      : { ...f.token, expiresAtMs: 0 };
    if (replace) writeStoredToken(f.path, expected);
    released.resolve(
      Response.json({
        access_token: "fake-stale-access",
        refresh_token: "fake-stale-refresh",
        expires_in: 3600,
      }),
    );
    await expect(pending).rejects.toThrow();
    expect(readStoredToken(f.path)).toEqual(expected);
    await expect(auth.ensureFresh()).rejects.toThrow("revoked");
    expect(requests).toBe(1);
  },
);

test("revocation after token load fences the GraphQL request before transport dispatch", async () => {
  const f = fixture();
  const auth = createLinearAuth({
    db: f.db,
    tokenPath: f.path,
    clientId: "client",
    clientSecret: "fake-secret",
    isAuthorized: f.allowed,
  });
  let requests = 0;
  const client = createLinearClient({
    auth,
    fetch: async () => {
      requests++;
      return Response.json({ data: {} });
    },
  });
  const pending = client.query("mutation { issueUpdate { success } }");
  f.revoke();
  await expect(pending).rejects.toThrow("revoked");
  expect(requests).toBe(0);
});

test("a revoked installation leaves webhook dispatch available but starts no catch-up polling", async () => {
  const f = fixture();
  f.revoke();
  let requests = 0;
  const opened = openLinear({
    db: f.db,
    secretsDir: join(f.home, "secrets"),
    env: { LINEAR_CLIENT_ID: "client", LINEAR_APP_USER_ID: "app" },
    publicUrl: null,
    noTunnel: true,
    isAuthorized: f.allowed,
    fetch: async () => {
      requests++;
      throw new Error("Offline request must not run");
    },
  });
  expect(opened.tracker).not.toBeNull();
  expect(opened.webhook.onEvent).toBeDefined();
  const running = opened.start(0);
  cleanup.push(() => running.stop());
  await running.catchUp();
  expect(requests).toBe(0);
});

test("revocation for another client or app user does not block the configured installation", async () => {
  const f = fixture();
  recordLinearInstallation(f.db, {
    ...scope,
    organizationId: "other-org",
    oauthClientId: "other-client",
    appUserId: "other-app",
    sessionId: "other",
    teamId: "other-team",
    observedAtMs: 1,
  });
  revokeLinearInstallation(f.db, {
    organizationId: "other-org",
    oauthClientId: "other-client",
    eventKey: "other-revoked",
    createdAtMs: 2,
  });
  expect(f.allowed()).toBe(true);
  expect(isLinearAppRevoked(f.db, { oauthClientId: "other-client", appUserId: "app" })).toBe(true);
  expect(isLinearAppRevoked(f.db, { oauthClientId: "client", appUserId: "other-app" })).toBe(false);
  const auth = createLinearAuth({
    db: f.db,
    tokenPath: f.path,
    clientId: "client",
    clientSecret: "fake-secret",
    isAuthorized: f.allowed,
  });
  expect(await auth.ensureFresh()).toBe(f.token.accessToken);
});

test("incomplete configured identity cannot bypass a possibly matching revocation", () => {
  const f = fixture();
  f.revoke();
  expect(isLinearAppRevoked(f.db, { oauthClientId: "client", appUserId: null })).toBe(true);
  expect(isLinearAppRevoked(f.db, { oauthClientId: null, appUserId: "app" })).toBe(true);
  expect(isLinearAppRevoked(f.db, { oauthClientId: null, appUserId: null })).toBe(true);
  expect(isLinearAppRevoked(f.db, { oauthClientId: "client", appUserId: "not-yet-known" })).toBe(
    true,
  );
  expect(isLinearAppRevoked(f.db, { oauthClientId: "different-client", appUserId: null })).toBe(
    false,
  );
});

test("the production startup guard uses persisted revocation when the configured app user is absent", async () => {
  const child = Bun.spawn(
    [process.execPath, "test/fixtures/linear-revoked-startup.ts", tempHome()],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual({ requests: 0 });
});
