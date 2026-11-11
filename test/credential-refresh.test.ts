import { expect, spyOn, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createLinearAuth, readStoredToken } from "../src/linear";
import { claimNextJob, completeJob, listJobs, migrate, openDatabase, sqliteDb } from "../src/db";
import { refreshCredential } from "../src/credentials";
import { storeLinearToken, tempHome } from "./helpers";

async function initial(home: string): Promise<string> {
  await storeLinearToken(home, {
    accessToken: "synthetic-access-old",
    refreshToken: "synthetic-refresh-old",
    expiresAtMs: 0,
    scope: "read,write",
    actor: "app",
  });
  return join(home, "secrets");
}

async function storedRefresh(home: string): Promise<string | null | undefined> {
  const db = openDatabase(join(home, "paws.db"));
  try {
    return (await readStoredToken(sqliteDb(db), join(home, "secrets")))?.refreshToken;
  } finally {
    db.close();
  }
}

function spawnRefresh(home: string, port: number, mode: string) {
  return Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      new URL("./fixtures/credential-refresh.ts", import.meta.url).pathname,
      home,
      `http://127.0.0.1:${port}/token`,
      mode,
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        KYOTOAGENT_ROOT: join(home, "kyoto"),
        PAWS_HOME: home,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

test("a refresh waiter rereads credentials when another worker completes between its reads", async () => {
  const home = tempHome();
  const db = openDatabase(join(home, "paws.db"));
  migrate(db);
  let stored = { accessToken: "synthetic-access-old", refreshToken: "synthetic-refresh-old" };
  const rotated = { accessToken: "synthetic-access-new", refreshToken: "synthetic-refresh-new" };
  let reads = 0;
  try {
    const value = await refreshCredential({
      db,
      identity: "synthetic-linear-install",
      *read() {
        yield* [];
        const snapshot = stored;
        if (++reads === 2)
          void (async () => {
            const job = await claimNextJob(sqliteDb(db), { workerId: "competing-refresh" });
            expect(job).not.toBeNull();
            stored = rotated;
            expect(await completeJob(sqliteDb(db), job!)).toBe(true);
          })();
        return snapshot;
      },
      *write(_q, credential) {
        yield* [];
        stored = credential;
      },
      async refresh() {
        throw new Error("The competing worker already refreshed the credential.");
      },
    });
    expect(value).toEqual(rotated);
    expect((await listJobs(sqliteDb(db))).map((job) => job.status)).toEqual(["done"]);
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a refresh discards its rotation when its claim expires during the latest read", async () => {
  const home = tempHome();
  const db = openDatabase(join(home, "paws.db"));
  migrate(db);
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  let stored = { accessToken: "synthetic-access-old", refreshToken: "synthetic-refresh-old" };
  const replacement = {
    accessToken: "synthetic-access-peer",
    refreshToken: "synthetic-refresh-peer",
  };
  let reads = 0;
  let writes = 0;
  try {
    const value = await refreshCredential({
      db,
      identity: "synthetic-expired-refresh",
      leaseMs: 100,
      *read() {
        yield* [];
        const snapshot = stored;
        if (++reads === 3) {
          now += 101;
          stored = replacement;
        }
        return snapshot;
      },
      *write(_q, credential) {
        yield* [];
        writes += 1;
        stored = credential;
      },
      async refresh() {
        return { accessToken: "synthetic-access-stale", refreshToken: "synthetic-refresh-stale" };
      },
    });
    expect(value).toEqual(replacement);
    expect(stored).toEqual(replacement);
    expect(writes).toBe(0);
    expect((await listJobs(sqliteDb(db)))[0]?.status).toBe("running");
  } finally {
    clock.mockRestore();
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// Two connections migrate and fsync with synchronous=FULL. Under CI's four parallel test files this
// can pass Bun's 5 s default, so it gets the same budget as `bun run test`.
test("credential publication holds the SQLite writer lock through read and write", async () => {
  const home = tempHome();
  const db = openDatabase(join(home, "paws.db"));
  migrate(db);
  const peer = openDatabase(join(home, "paws.db"));
  peer.run("PRAGMA busy_timeout=0");
  const stored = { accessToken: "synthetic-access-old", refreshToken: "synthetic-refresh-old" };
  let reads = 0;
  let lockedReads = 0;
  const claim = () => peer.run("BEGIN IMMEDIATE");
  try {
    await refreshCredential({
      db,
      identity: "synthetic-serialized-refresh",
      *read() {
        yield* [];
        if (++reads === 3) {
          expect(claim).toThrow("database is locked");
          lockedReads += 1;
        }
        return stored;
      },
      *write() {
        yield* [];
        expect(claim).toThrow("database is locked");
        lockedReads += 1;
      },
      async refresh() {
        return { accessToken: "synthetic-access-new", refreshToken: "synthetic-refresh-new" };
      },
    });
    expect(lockedReads).toBe(2);
    expect((await listJobs(sqliteDb(peer)))[0]?.status).toBe("done");
  } finally {
    peer.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);

test("separate Linear clients share one durable refresh job and rotate the encrypted token", async () => {
  const home = tempHome();
  const secretsDir = await initial(home);
  const db = openDatabase(join(home, "paws.db"));
  migrate(db);
  let requests = 0;
  const options = {
    db,
    secretsDir,
    clientId: "synthetic-client",
    clientSecret: "synthetic-client-secret",
    fetch: async () => {
      requests += 1;
      await Bun.sleep(75);
      return Response.json({
        access_token: "synthetic-access-new",
        refresh_token: "synthetic-refresh-new",
        expires_in: 3600,
      });
    },
  };
  try {
    const clients = await Promise.all(Array.from({ length: 5 }, () => createLinearAuth(options)));
    expect(await Promise.all(clients.map((client) => client.ensureFresh()))).toEqual(
      Array(5).fill("synthetic-access-new"),
    );
    expect(requests).toBe(1);
    expect((await listJobs(sqliteDb(db))).map((job) => job.status)).toEqual(["done"]);
    expect((await readStoredToken(sqliteDb(db), secretsDir))?.refreshToken).toBe(
      "synthetic-refresh-new",
    );
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a killed refresh process replays the consumed Linear token after restart and persists its rotation", async () => {
  const home = tempHome();
  await initial(home);
  const bodies: string[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = new URLSearchParams(await request.text());
      bodies.push(body.get("refresh_token")!);
      return Response.json({
        access_token: "synthetic-access-rotated",
        refresh_token: "synthetic-refresh-rotated",
        expires_in: 3600,
      });
    },
  });
  const spawn = (mode: string) => spawnRefresh(home, provider.port!, mode);
  const first = spawn("crash");
  let second: ReturnType<typeof spawn> | undefined;
  try {
    const reader = first.stdout.getReader();
    // The fixture starts Bun and migrates a fresh database first; a loaded CI runner took over 3s.
    const ready = await Promise.race([
      reader.read(),
      Bun.sleep(10_000).then(() => {
        throw new Error("refresh fixture did not reach the provider");
      }),
    ]);
    expect(new TextDecoder().decode(ready.value)).toContain("provider rotated");
    first.kill("SIGKILL");
    await first.exited;
    expect(await storedRefresh(home)).toBe("synthetic-refresh-old");
    second = spawn("recover");
    expect(await second.exited).toBe(0);
    expect(await new Response(second.stderr).text()).toBe("");
    expect(bodies).toEqual(["synthetic-refresh-old", "synthetic-refresh-old"]);
    expect(await storedRefresh(home)).toBe("synthetic-refresh-rotated");
    const db = openDatabase(join(home, "paws.db"));
    expect(
      (await listJobs(sqliteDb(db))).map((job) => ({ status: job.status, attempts: job.attempts })),
    ).toEqual([{ status: "done", attempts: 2 }]);
    db.close();
    const artifacts = [
      join(home, "paws.db"),
      ...readdirSync(join(home, "secrets"))
        .filter((name) => name !== ".envelope-key")
        .map((name) => join(home, "secrets", name)),
    ];
    for (const artifact of artifacts) {
      const bytes = readFileSync(artifact).toString();
      for (const value of [
        "synthetic-access-old",
        "synthetic-refresh-old",
        "synthetic-access-rotated",
        "synthetic-refresh-rotated",
        "synthetic-client-secret",
      ])
        expect(bytes).not.toContain(value);
    }
  } finally {
    first.kill();
    second?.kill();
    await provider.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
}, 10_000);

test("refresh failures keep the prior token and persist only a sanitized retry error", async () => {
  const home = tempHome();
  const secretsDir = await initial(home);
  const db = openDatabase(join(home, "paws.db"));
  migrate(db);
  try {
    const auth = await createLinearAuth({
      db,
      secretsDir,
      clientId: "synthetic-client",
      clientSecret: "synthetic-client-secret",
      fetch: async () => {
        throw new Error("synthetic-refresh-old synthetic-client-secret");
      },
    });
    await expect(auth.ensureFresh()).rejects.toThrow("Integration token refresh failed");
    expect((await readStoredToken(sqliteDb(db), secretsDir))?.refreshToken).toBe(
      "synthetic-refresh-old",
    );
    expect((await listJobs(sqliteDb(db)))[0]?.lastError).toBe("Integration token refresh failed.");
    expect((await listJobs(sqliteDb(db)))[0]?.status).toBe("pending");
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("after one process refreshes, another process's next call uses the new token", async () => {
  const home = tempHome();
  await storeLinearToken(home, {
    accessToken: "acme-access-old",
    refreshToken: "acme-refresh-old",
    expiresAtMs: Date.now() + 600_000,
    scope: "read,write",
    actor: "app",
  });
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json({
        access_token: "acme-access-new",
        refresh_token: "acme-refresh-new",
        expires_in: 3600,
      }),
  });
  const replica = tempHome();
  const replicaSecrets = join(replica, "secrets");
  mkdirSync(replicaSecrets, { mode: 0o700 });
  copyFileSync(join(home, "secrets", ".envelope-key"), join(replicaSecrets, ".envelope-key"));
  const db = openDatabase(join(home, "paws.db"));
  let requests = 0;
  try {
    const auth = await createLinearAuth({
      db,
      secretsDir: replicaSecrets,
      clientId: "acme-client",
      clientSecret: "acme-client-secret",
      fetch: async () => {
        requests += 1;
        throw new Error("This process must not refresh.");
      },
    });
    expect(await auth.ensureFresh()).toBe("acme-access-old");
    const other = spawnRefresh(home, provider.port!, "recover");
    expect(await other.exited).toBe(0);
    expect(await auth.ensureFresh()).toBe("acme-access-new");
    expect((await readStoredToken(sqliteDb(db), replicaSecrets))?.refreshToken).toBe(
      "acme-refresh-new",
    );
    expect(requests).toBe(0);
  } finally {
    db.close();
    await provider.stop(true);
    rmSync(home, { recursive: true, force: true });
    rmSync(replica, { recursive: true, force: true });
  }
}, 20_000);
