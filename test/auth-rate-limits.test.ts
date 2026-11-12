import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { count } from "drizzle-orm";
import { postgresDb, type Db } from "../src/db";
import { createBrowserOnboarding } from "../src/onboarding";
import { startServer } from "../src/server";
import {
  beginWorkspaceOAuth,
  createWorkspaceAccess,
  startWorkspaceAccess,
  type WorkspaceAccess,
} from "../src/workspace";
import { pgliteDb } from "./pglite";

const cleanups: (() => void | Promise<void>)[] = [];
const origin = "https://paws.example";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "paws-sign-in-rate-limits-"));
  const pg = await pgliteDb();
  cleanups.push(async () => {
    await pg.$client.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { home, db: postgresDb(pg), another: postgresDb(pg) };
}

async function requests(db: Db) {
  return await db.run((q) =>
    q.one(q.orm.select({ count: count() }).from(q.t.workspaceOauthRequest)),
  );
}

function options(db: Db) {
  return {
    store: db,
    publicUrl: origin,
    clientId: "fixture-client",
    installedOrganization: { id: "org", name: "Workspace" },
    memberships: {
      async installation() {
        return { id: "org", name: "Workspace" };
      },
      async member(): Promise<never> {
        throw new Error("Unexpected membership read");
      },
    },
  };
}

test("production access keeps one visitor's failed callbacks separate from another's", async () => {
  const { db } = await fixture();
  const runtime = startWorkspaceAccess({ ...options(db), onError() {} });
  cleanups.push(() => runtime.stop());
  const access: WorkspaceAccess = await runtime.access;
  const request = () => new Request(`${origin}/auth/linear/callback`);
  for (let attempt = 0; attempt < 5; attempt++)
    expect((await access.handle(request(), { ip: "192.0.2.1" }))?.status).toBe(400);
  expect((await access.handle(request(), { ip: "192.0.2.1" }))?.status).toBe(429);
  expect((await access.handle(request(), { ip: "192.0.2.2" }))?.status).toBe(400);
});

test("ordinary GET and POST sign-in starts share a per-client limit before saving state", async () => {
  const { db } = await fixture();
  let now = 1_000;
  const access = createWorkspaceAccess({ ...options(db), now: () => now, log() {} });
  cleanups.push(() => access.stop());
  const start = (ip: string, method = "GET") =>
    access.handle(new Request(`${origin}/auth/linear`, { method, headers: { origin } }), { ip });
  for (let attempt = 0; attempt < 10; attempt++)
    expect((await start("192.0.2.1", attempt % 2 ? "POST" : "GET"))?.status).toBe(303);
  const blocked = await start("192.0.2.1");
  expect(blocked?.status).toBe(429);
  expect(blocked?.headers.get("retry-after")).toBe("60");
  expect(await requests(db)).toEqual({
    count: 10,
  });
  expect((await start("192.0.2.2"))?.status).toBe(303);
  now += 60_000;
  expect((await start("192.0.2.1"))?.status).toBe(303);
});

for (const reconnect of [false, true])
  test(`browser onboarding limits sign-in starts before saving state, reconnect=${reconnect}`, async () => {
    const { db, home } = await fixture();
    let now = 1_000;
    const handle = createBrowserOnboarding({
      db,
      home,
      origin,
      clientId: "fixture-client",
      clientSecret: "fixture-secret",
      expectedOrganizationId: "org",
      reconnect,
      now: () => now,
      installed() {},
    });
    const start = (ip: string) => handle(new Request(`${origin}/auth/linear`), { ip });
    for (let attempt = 0; attempt < 10; attempt++)
      expect((await start("192.0.2.1")).status).toBe(303);
    const blocked = await start("192.0.2.1");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect(await requests(db)).toEqual({
      count: 10,
    });
    expect((await start("192.0.2.2")).status).toBe(303);
    now += 60_000;
    expect((await start("192.0.2.1")).status).toBe(303);
  });

test("OAuth state stays bounded across instances and admits starts after expiration", async () => {
  const { db, another } = await fixture();
  const start = (connection: Db, now = 1_000) =>
    beginWorkspaceOAuth(connection, {
      clientId: "fixture-client",
      origin,
      bootstrap: null,
      now,
    });
  for (let attempt = 0; attempt < 1_000; attempt++) expect((await start(db)).status).toBe(303);
  expect((await start(another)).status).toBe(429);
  expect(await requests(db)).toEqual({
    count: 1_000,
  });
  expect((await start(another, 601_000)).status).toBe(303);
  expect(await requests(db)).toEqual({
    count: 1,
  });
});

test("the server supplies onboarding with the socket peer instead of forwarded headers", async () => {
  const server = startServer({
    hostname: "127.0.0.1",
    port: 0,
    onboarding(_request, client) {
      return Promise.resolve(Response.json({ ip: client.ip }));
    },
  });
  cleanups.push(() => server.stop(true));
  const response = await fetch(`http://127.0.0.1:${server.port}/auth/linear`, {
    headers: { "x-forwarded-for": "192.0.2.100", "x-real-ip": "192.0.2.101" },
  });
  expect(await response.json()).toEqual({ ip: "127.0.0.1" });
});
