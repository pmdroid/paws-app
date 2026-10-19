import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import {
  getLinearSessionAccess,
  isLinearAppRevoked,
  listLinearInstallationRevocations,
  migrate,
  openDatabase,
  recordLinearInstallation,
  revokeLinearInstallation,
} from "../src/db";
import { createLinearReconnect } from "../src/onboarding";
import {
  createLinearAuth,
  linearTokenPath,
  readStoredToken,
  writeStoredToken,
  type StoredLinearToken,
} from "../src/linear";
import { tempHome } from "./helpers";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };
const verified = () =>
  Response.json({ data: { viewer: { id: "app", app: true, organization: { id: "org" } } } });

function fixture(known = true) {
  const home = tempHome();
  const path = linearTokenPath(join(home, "secrets"));
  const db = openDatabase(join(home, "paws.db"));
  cleanup.push(() => db.close());
  migrate(db);
  if (known)
    recordLinearInstallation(db, {
      ...scope,
      sessionId: "session",
      teamId: "team",
      observedAtMs: 1,
    });
  revokeLinearInstallation(db, { ...scope, eventKey: "first", createdAtMs: 10 });
  const previous: StoredLinearToken = {
    accessToken: "fake-old-access",
    refreshToken: "fake-old-refresh",
    expiresAtMs: 0,
    scope: "read,write",
    actor: "app",
  };
  const next = { ...previous, accessToken: "fake-new-access", refreshToken: "fake-new-refresh" };
  writeStoredToken(path, previous);
  return { home, path, db, previous, next };
}

test("verified host reconnection persists a new credential and restores the same installation across reopen", async () => {
  const f = fixture();
  const requests: { url: string; init?: RequestInit }[] = [];
  const reconnect = createLinearReconnect({
    now: () => 20,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return verified();
    },
  })(f.home);
  expect(await reconnect.complete({ clientId: "client", token: f.next })).toBe(true);
  expect(readStoredToken(f.path)).toEqual(f.next);
  const reopened = openDatabase(join(f.home, "paws.db"));
  try {
    expect(getLinearSessionAccess(reopened, "session")).toBe("allowed");
    expect(isLinearAppRevoked(reopened, scope)).toBe(false);
    expect(listLinearInstallationRevocations(reopened)).toEqual([]);
    expect(reopened.query("SELECT * FROM linear_app_revocation").get()).toMatchObject({
      revoked_at: 10,
      generation: 1,
      restored_after: 20,
    });
  } finally {
    reopened.close();
  }
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe("https://api.linear.app/graphql");
  expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
    "Bearer fake-new-access",
  );
  expect(String(requests[0]?.init?.body)).toContain("viewer { id app organization { id } }");
});

test("an unchanged credential cannot restore access or make a verification request", async () => {
  const f = fixture();
  let requests = 0;
  const reconnect = createLinearReconnect({
    now: () => 20,
    fetch: async () => {
      requests++;
      return verified();
    },
  })(f.home);
  await expect(reconnect.complete({ clientId: "client", token: f.previous })).rejects.toThrow(
    "new authorization grant",
  );
  expect(requests).toBe(0);
  expect(getLinearSessionAccess(f.db, "session")).toBe("revoked");
});

test("a claimed OAuth client without a verified app user cannot restore a revoked installation", async () => {
  const f = fixture(false);
  const reconnect = createLinearReconnect({ now: () => 20, fetch: async () => verified() })(f.home);
  await expect(reconnect.complete({ clientId: "client", token: f.next })).rejects.toThrow(
    "verified installation",
  );
  expect(readStoredToken(f.path)).toEqual(f.previous);
  expect(isLinearAppRevoked(f.db, { oauthClientId: "client", appUserId: null })).toBe(true);
});

test.each(["human", "other-app", "unauthorized", "errors", "missing"])(
  "unverified new credential %s leaves both credential and revocation unchanged",
  async (kind) => {
    const f = fixture();
    const reconnect = createLinearReconnect({
      now: () => 20,
      fetch: async () => {
        if (kind === "unauthorized") return new Response("denied", { status: 401 });
        if (kind === "errors") return Response.json({ errors: [{ message: "denied" }] });
        if (kind === "missing") return Response.json({ data: {} });
        return Response.json({
          data: {
            viewer: {
              id: kind === "other-app" ? "other" : "app",
              app: kind !== "human",
              organization: { id: "org" },
            },
          },
        });
      },
    })(f.home);
    await expect(reconnect.complete({ clientId: "client", token: f.next })).rejects.toThrow();
    expect(readStoredToken(f.path)).toEqual(f.previous);
    expect(getLinearSessionAccess(f.db, "session")).toBe("revoked");
  },
);

test.each(["revocation", "credential"])(
  "a concurrent %s change fences verified completion",
  async (kind) => {
    const f = fixture();
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<Response>();
    const reconnect = createLinearReconnect({
      now: () => 20,
      fetch: async () => {
        started.resolve();
        return released.promise;
      },
    })(f.home);
    const pending = reconnect.complete({ clientId: "client", token: f.next });
    await started.promise;
    const expected =
      kind === "credential" ? { ...f.previous, accessToken: "fake-operator-access" } : f.previous;
    if (kind === "credential") writeStoredToken(f.path, expected);
    else revokeLinearInstallation(f.db, { ...scope, eventKey: "during", createdAtMs: 25 });
    released.resolve(verified());
    await expect(pending).rejects.toThrow();
    expect(readStoredToken(f.path)).toEqual(expected);
    expect(getLinearSessionAccess(f.db, "session")).toBe("revoked");
  },
);

test.each([20, 25])(
  "a delayed revocation at %s reactivates the fence after verified completion",
  async (createdAtMs) => {
    const f = fixture();
    const reconnect = createLinearReconnect({ now: () => 20, fetch: async () => verified() })(
      f.home,
    );
    await reconnect.complete({ clientId: "client", token: f.next });
    expect(revokeLinearInstallation(f.db, { ...scope, eventKey: "delayed", createdAtMs })).toEqual([
      "session",
    ]);
    expect(getLinearSessionAccess(f.db, "session")).toBe("revoked");
    expect(listLinearInstallationRevocations(f.db)[0]?.generation).toBe(2);
  },
);

test("historical revocation before the captured grant start stays deduped and cannot cancel the new installation", async () => {
  const f = fixture();
  const reconnect = createLinearReconnect({ now: () => 20, fetch: async () => verified() })(f.home);
  await reconnect.complete({ clientId: "client", token: f.next });
  for (let i = 0; i < 2; i++) {
    expect(
      revokeLinearInstallation(f.db, { ...scope, eventKey: "historical", createdAtMs: 19 }),
    ).toEqual([]);
    expect(getLinearSessionAccess(f.db, "session")).toBe("allowed");
  }
});

test("a failed restoration write leaves both the credential and fence unchanged", async () => {
  const f = fixture();
  const reconnect = createLinearReconnect({ now: () => 20, fetch: async () => verified() })(f.home);
  f.db.run(
    "CREATE TRIGGER fail_restore BEFORE UPDATE ON linear_app_revocation BEGIN SELECT RAISE(ABORT, 'restore failed'); END",
  );
  await expect(reconnect.complete({ clientId: "client", token: f.next })).rejects.toThrow(
    "restore failed",
  );
  expect(readStoredToken(f.path)).toEqual(f.previous);
  expect(getLinearSessionAccess(f.db, "session")).toBe("revoked");
});

test("a refresh started before revocation cannot overwrite the verified host reconnect credential", async () => {
  const f = fixture();
  await createLinearReconnect({ now: () => 20, fetch: async () => verified() })(f.home).complete({
    clientId: "client",
    token: f.next,
  });
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<Response>();
  const auth = createLinearAuth({
    db: f.db,
    tokenPath: f.path,
    clientId: "client",
    clientSecret: "fake-secret",
    isAuthorized: () => !isLinearAppRevoked(f.db, scope),
    fetch: async () => {
      started.resolve();
      return released.promise;
    },
  });
  const pending = auth.ensureFresh();
  await started.promise;
  revokeLinearInstallation(f.db, { ...scope, eventKey: "next-revocation", createdAtMs: 30 });
  const latest = {
    ...f.next,
    accessToken: "fake-reconnected-access",
    refreshToken: "fake-reconnected-refresh",
  };
  await createLinearReconnect({ now: () => 40, fetch: async () => verified() })(f.home).complete({
    clientId: "client",
    token: latest,
  });
  released.resolve(
    Response.json({
      access_token: "fake-stale-access",
      refresh_token: "fake-stale-refresh",
      expires_in: 3600,
    }),
  );
  expect(await pending).toBe(latest.accessToken);
  expect(readStoredToken(f.path)).toEqual(latest);
  expect(getLinearSessionAccess(f.db, "session")).toBe("allowed");
});
