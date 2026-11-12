import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import {
  getLinearSessionAccess,
  isLinearAppRevoked,
  listLinearInstallationRevocations,
  openPawsStore,
  recordLinearInstallation,
  revokeLinearInstallation,
} from "../src/db";
import { createLinearReconnect } from "../src/onboarding";
import {
  createLinearAuth,
  readStoredToken,
  writeStoredToken,
  type StoredLinearToken,
} from "../src/linear";
import { sql } from "drizzle-orm";
import { seed } from "./dialects";
import { tempHome } from "./helpers";
import { copyMigratedPglite } from "./pglite";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };
const verified = () =>
  Response.json({ data: { viewer: { id: "app", app: true, organization: { id: "org" } } } });

async function fixture(known = true) {
  const home = tempHome();
  const secretsDir = join(home, "secrets");
  const pgliteDir = join(home, "pglite");
  await copyMigratedPglite(pgliteDir);
  const open = await openPawsStore({ url: null, pgliteDir });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await open.close();
  };
  cleanup.push(close);
  const db = open.store;
  if (known)
    await recordLinearInstallation(db, {
      ...scope,
      sessionId: "session",
      teamId: "team",
      observedAtMs: 1,
    });
  await revokeLinearInstallation(db, { ...scope, eventKey: "first", createdAtMs: 10 });
  const previous: StoredLinearToken = {
    accessToken: "fake-old-access",
    refreshToken: "fake-old-refresh",
    expiresAtMs: 0,
    scope: "read,write",
    actor: "app",
  };
  const next = { ...previous, accessToken: "fake-new-access", refreshToken: "fake-new-refresh" };
  await writeStoredToken(db, secretsDir, previous);
  return { home, secretsDir, pgliteDir, db, close, previous, next };
}

test("verified host reconnection persists a new credential and restores the same installation across reopen", async () => {
  const f = await fixture();
  const requests: { url: string; init?: RequestInit }[] = [];
  const reconnect = await createLinearReconnect({
    now: () => 20,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return verified();
    },
  })(f.db, f.home);
  expect(await reconnect.complete({ clientId: "client", token: f.next })).toBe(true);
  expect(await readStoredToken(f.db, f.secretsDir)).toEqual(f.next);
  await f.close();
  const reopened = await openPawsStore({ url: null, pgliteDir: f.pgliteDir });
  try {
    expect(await getLinearSessionAccess(reopened.store, "session")).toBe("allowed");
    expect(await isLinearAppRevoked(reopened.store, scope)).toBe(false);
    expect(await listLinearInstallationRevocations(reopened.store)).toEqual([]);
    expect(
      await reopened.store.run((q) => q.all(q.orm.select().from(q.t.linearAppRevocation))),
    ).toMatchObject([{ revokedAt: 10, generation: 1, restoredAfter: 20 }]);
  } finally {
    await reopened.close();
  }
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe("https://api.linear.app/graphql");
  expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
    "Bearer fake-new-access",
  );
  expect(String(requests[0]?.init?.body)).toContain("viewer { id app organization { id } }");
});

test("an unchanged credential cannot restore access or make a verification request", async () => {
  const f = await fixture();
  let requests = 0;
  const reconnect = await createLinearReconnect({
    now: () => 20,
    fetch: async () => {
      requests++;
      return verified();
    },
  })(f.db, f.home);
  await expect(reconnect.complete({ clientId: "client", token: f.previous })).rejects.toThrow(
    "new authorization grant",
  );
  expect(requests).toBe(0);
  expect(await getLinearSessionAccess(f.db, "session")).toBe("revoked");
});

test("a claimed OAuth client without a verified app user cannot restore a revoked installation", async () => {
  const f = await fixture(false);
  const reconnect = await createLinearReconnect({ now: () => 20, fetch: async () => verified() })(
    f.db,
    f.home,
  );
  await expect(reconnect.complete({ clientId: "client", token: f.next })).rejects.toThrow(
    "verified installation",
  );
  expect(await readStoredToken(f.db, f.secretsDir)).toEqual(f.previous);
  expect(await isLinearAppRevoked(f.db, { oauthClientId: "client", appUserId: null })).toBe(true);
});

test.each(["human", "other-app", "unauthorized", "errors", "missing"])(
  "unverified new credential %s leaves both credential and revocation unchanged",
  async (kind) => {
    const f = await fixture();
    const reconnect = await createLinearReconnect({
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
    })(f.db, f.home);
    await expect(reconnect.complete({ clientId: "client", token: f.next })).rejects.toThrow();
    expect(await readStoredToken(f.db, f.secretsDir)).toEqual(f.previous);
    expect(await getLinearSessionAccess(f.db, "session")).toBe("revoked");
  },
);

test.each(["revocation", "credential"])(
  "a concurrent %s change fences verified completion",
  async (kind) => {
    const f = await fixture();
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<Response>();
    const reconnect = await createLinearReconnect({
      now: () => 20,
      fetch: async () => {
        started.resolve();
        return released.promise;
      },
    })(f.db, f.home);
    const pending = reconnect.complete({ clientId: "client", token: f.next });
    await started.promise;
    const expected =
      kind === "credential" ? { ...f.previous, accessToken: "fake-operator-access" } : f.previous;
    if (kind === "credential") await writeStoredToken(f.db, f.secretsDir, expected);
    else
      await revokeLinearInstallation(f.db, {
        ...scope,
        eventKey: "during",
        createdAtMs: 25,
      });
    released.resolve(verified());
    await expect(pending).rejects.toThrow();
    expect(await readStoredToken(f.db, f.secretsDir)).toEqual(expected);
    expect(await getLinearSessionAccess(f.db, "session")).toBe("revoked");
  },
);

test.each([20, 25])(
  "a delayed revocation at %s reactivates the fence after verified completion",
  async (createdAtMs) => {
    const f = await fixture();
    const reconnect = await createLinearReconnect({ now: () => 20, fetch: async () => verified() })(
      f.db,
      f.home,
    );
    await reconnect.complete({ clientId: "client", token: f.next });
    expect(
      await revokeLinearInstallation(f.db, {
        ...scope,
        eventKey: "delayed",
        createdAtMs,
      }),
    ).toEqual(["session"]);
    expect(await getLinearSessionAccess(f.db, "session")).toBe("revoked");
    expect((await listLinearInstallationRevocations(f.db))[0]?.generation).toBe(2);
  },
);

test("historical revocation before the captured grant start stays deduped and cannot cancel the new installation", async () => {
  const f = await fixture();
  const reconnect = await createLinearReconnect({ now: () => 20, fetch: async () => verified() })(
    f.db,
    f.home,
  );
  await reconnect.complete({ clientId: "client", token: f.next });
  for (let i = 0; i < 2; i++) {
    expect(
      await revokeLinearInstallation(f.db, {
        ...scope,
        eventKey: "historical",
        createdAtMs: 19,
      }),
    ).toEqual([]);
    expect(await getLinearSessionAccess(f.db, "session")).toBe("allowed");
  }
});

test("a failed restoration write leaves both the credential and fence unchanged", async () => {
  const f = await fixture();
  const reconnect = await createLinearReconnect({ now: () => 20, fetch: async () => verified() })(
    f.db,
    f.home,
  );
  await seed(
    f.db,
    (q) =>
      q.orm.execute(
        sql`CREATE FUNCTION fail_restore() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'restore failed'; END $$ LANGUAGE plpgsql`,
      ),
    (q) =>
      q.orm.execute(
        sql`CREATE TRIGGER fail_restore BEFORE UPDATE ON linear_app_revocation FOR EACH ROW EXECUTE FUNCTION fail_restore()`,
      ),
  );
  const error = (await reconnect
    .complete({ clientId: "client", token: f.next })
    .catch((e: unknown) => e)) as Error;
  expect(String(error.cause)).toContain("restore failed");
  expect(await readStoredToken(f.db, f.secretsDir)).toEqual(f.previous);
  expect(await getLinearSessionAccess(f.db, "session")).toBe("revoked");
});

test("a refresh started before revocation cannot overwrite the verified host reconnect credential", async () => {
  const f = await fixture();
  await (
    await createLinearReconnect({ now: () => 20, fetch: async () => verified() })(f.db, f.home)
  ).complete({
    clientId: "client",
    token: f.next,
  });
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<Response>();
  const auth = await createLinearAuth({
    db: f.db,
    secretsDir: f.secretsDir,
    clientId: "client",
    clientSecret: "fake-secret",
    isAuthorized: async () => !(await isLinearAppRevoked(f.db, scope)),
    fetch: async () => {
      started.resolve();
      return released.promise;
    },
  });
  const pending = auth.ensureFresh();
  await started.promise;
  await revokeLinearInstallation(f.db, {
    ...scope,
    eventKey: "next-revocation",
    createdAtMs: 30,
  });
  const latest = {
    ...f.next,
    accessToken: "fake-reconnected-access",
    refreshToken: "fake-reconnected-refresh",
  };
  await (
    await createLinearReconnect({ now: () => 40, fetch: async () => verified() })(f.db, f.home)
  ).complete({
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
  expect(await readStoredToken(f.db, f.secretsDir)).toEqual(latest);
  expect(await getLinearSessionAccess(f.db, "session")).toBe("allowed");
});
