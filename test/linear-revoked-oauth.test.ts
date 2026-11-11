import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import {
  isLinearAppRevoked,
  recordLinearInstallation,
  revokeLinearInstallation,
  sqliteDb,
} from "../src/db";
import {
  createLinearAuth,
  createLinearClient,
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
async function fixture() {
  const db = tempDb();
  cleanup.push(() => db.close());
  await recordLinearInstallation(sqliteDb(db), {
    ...scope,
    sessionId: "session",
    teamId: "team",
    observedAtMs: 1,
  });
  const home = tempHome();
  const secretsDir = join(home, "secrets");
  const token: StoredLinearToken = {
    accessToken: "fake-old-access",
    refreshToken: "fake-old-refresh",
    expiresAtMs: Date.now() + 600_000,
    scope: "read,write",
    actor: "app",
  };
  writeStoredToken(db, secretsDir, token);
  const revoke = async () =>
    await revokeLinearInstallation(sqliteDb(db), { ...scope, eventKey: "revoked", createdAtMs: 2 });
  return {
    db,
    home,
    secretsDir,
    token,
    revoke,
    allowed: async () => !isLinearAppRevoked(db, scope),
  };
}

test("known revocation blocks fresh credentials and refresh without a network request", async () => {
  const f = await fixture();
  let requests = 0;
  const auth = createLinearAuth({
    db: f.db,
    secretsDir: f.secretsDir,
    clientId: "client",
    clientSecret: "fake-secret",
    isAuthorized: f.allowed,
    fetch: async () => {
      requests++;
      throw new Error("Offline request must not run");
    },
  });
  await f.revoke();
  expect(auth.hasToken()).toBe(true);
  await expect(auth.ensureFresh()).rejects.toThrow("revoked");
  await expect(auth.forceRefresh()).rejects.toThrow("revoked");
  expect(requests).toBe(0);
  expect(readStoredToken(f.db, f.secretsDir)).toEqual(f.token);
});

test.each([false, true])(
  "revocation fences a pending refresh and preserves operator replacement=%s",
  async (replace) => {
    const f = await fixture();
    writeStoredToken(f.db, f.secretsDir, { ...f.token, expiresAtMs: 0 });
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<Response>();
    let requests = 0;
    const auth = createLinearAuth({
      db: f.db,
      secretsDir: f.secretsDir,
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
    await f.revoke();
    const expected = replace
      ? { ...f.token, accessToken: "fake-operator-access", refreshToken: "fake-operator-refresh" }
      : { ...f.token, expiresAtMs: 0 };
    if (replace) writeStoredToken(f.db, f.secretsDir, expected);
    released.resolve(
      Response.json({
        access_token: "fake-stale-access",
        refresh_token: "fake-stale-refresh",
        expires_in: 3600,
      }),
    );
    await expect(pending).rejects.toThrow();
    expect(readStoredToken(f.db, f.secretsDir)).toEqual(expected);
    await expect(auth.ensureFresh()).rejects.toThrow("revoked");
    expect(requests).toBe(1);
  },
);

test("revocation after token load fences the GraphQL request before transport dispatch", async () => {
  const f = await fixture();
  const auth = createLinearAuth({
    db: f.db,
    secretsDir: f.secretsDir,
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
  await f.revoke();
  await expect(pending).rejects.toThrow("revoked");
  expect(requests).toBe(0);
});

test("a revoked installation leaves webhook dispatch available but starts no catch-up polling", async () => {
  const f = await fixture();
  await f.revoke();
  let requests = 0;
  const opened = openLinear({
    db: f.db,
    secretsDir: join(f.home, "secrets"),
    env: { LINEAR_CLIENT_ID: "client", LINEAR_APP_USER_ID: "app" },
    isAuthorized: f.allowed,
    fetch: async () => {
      requests++;
      throw new Error("Offline request must not run");
    },
  });
  expect(opened.tracker).not.toBeNull();
  expect(opened.webhook.onEvent).toBeDefined();
  const running = await opened.start();
  cleanup.push(() => running.stop());
  await running.catchUp();
  expect(requests).toBe(0);
});

test("revocation for another client or app user does not block the configured installation", async () => {
  const f = await fixture();
  await recordLinearInstallation(sqliteDb(f.db), {
    ...scope,
    organizationId: "other-org",
    oauthClientId: "other-client",
    appUserId: "other-app",
    sessionId: "other",
    teamId: "other-team",
    observedAtMs: 1,
  });
  await revokeLinearInstallation(sqliteDb(f.db), {
    organizationId: "other-org",
    oauthClientId: "other-client",
    eventKey: "other-revoked",
    createdAtMs: 2,
  });
  expect(await f.allowed()).toBe(true);
  expect(isLinearAppRevoked(f.db, { oauthClientId: "other-client", appUserId: "app" })).toBe(true);
  expect(isLinearAppRevoked(f.db, { oauthClientId: "client", appUserId: "other-app" })).toBe(false);
  const auth = createLinearAuth({
    db: f.db,
    secretsDir: f.secretsDir,
    clientId: "client",
    clientSecret: "fake-secret",
    isAuthorized: f.allowed,
  });
  expect(await auth.ensureFresh()).toBe(f.token.accessToken);
});

test("incomplete configured identity cannot bypass a possibly matching revocation", async () => {
  const f = await fixture();
  await f.revoke();
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
