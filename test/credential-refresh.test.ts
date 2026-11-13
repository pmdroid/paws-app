import { expect, spyOn, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createLinearAuth, readStoredToken, writeStoredToken } from "../src/linear";
import { claimNextJob, completeJob, listJobs, type Db } from "../src/db";
import { refreshCredential } from "../src/credentials";
import { tempHome } from "./helpers";
import { pgliteServer, tempStore } from "./pglite";

async function initial(db: Db, home: string): Promise<string> {
  const secretsDir = join(home, "secrets");
  await writeStoredToken(db, secretsDir, {
    accessToken: "synthetic-access-old",
    refreshToken: "synthetic-refresh-old",
    expiresAtMs: 0,
    scope: "read,write",
    actor: "app",
  });
  return secretsDir;
}

async function storedRefresh(db: Db, home: string): Promise<string | null | undefined> {
  return (await readStoredToken(db, join(home, "secrets")))?.refreshToken;
}

function spawnRefresh(home: string, url: string, port: number, mode: string) {
  return Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      new URL("./fixtures/credential-refresh.ts", import.meta.url).pathname,
      home,
      url,
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
  const { db, close } = await tempStore();
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
            const job = await claimNextJob(db, { workerId: "competing-refresh" });
            expect(job).not.toBeNull();
            stored = rotated;
            expect(await completeJob(db, job!)).toBe(true);
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
    expect((await listJobs(db)).map((job) => job.status)).toEqual(["done"]);
  } finally {
    await close();
  }
});

test("a refresh discards its rotation when its claim expires during the latest read", async () => {
  const { db, close } = await tempStore();
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
    expect((await listJobs(db))[0]?.status).toBe("running");
  } finally {
    clock.mockRestore();
    await close();
  }
});

test("credential publication reads and writes in one transaction that peers see only once committed", async () => {
  const { db, close } = await tempStore();
  const stored = { accessToken: "synthetic-access-old", refreshToken: "synthetic-refresh-old" };
  let reads = 0;
  const peers: Promise<string | undefined>[] = [];
  const peek = () => peers.push(listJobs(db).then((jobs) => jobs[0]?.status));
  try {
    await refreshCredential({
      db,
      identity: "synthetic-serialized-refresh",
      *read() {
        yield* [];
        if (++reads === 3) peek();
        return stored;
      },
      *write() {
        yield* [];
        peek();
      },
      async refresh() {
        return { accessToken: "synthetic-access-new", refreshToken: "synthetic-refresh-new" };
      },
    });
    expect(await Promise.all(peers)).toEqual(["done", "done"]);
  } finally {
    await close();
  }
});

test("separate Linear clients share one durable refresh job and rotate the encrypted token", async () => {
  const home = tempHome();
  const { db, close } = await tempStore();
  const secretsDir = await initial(db, home);
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
    expect((await listJobs(db)).map((job) => job.status)).toEqual(["done"]);
    expect((await readStoredToken(db, secretsDir))?.refreshToken).toBe("synthetic-refresh-new");
  } finally {
    await close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a killed refresh process replays the consumed Linear token after restart and persists its rotation", async () => {
  const home = tempHome();
  const server = await pgliteServer();
  const db = server.store;
  await initial(db, home);
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
  const spawn = (mode: string) => spawnRefresh(home, server.url, provider.port!, mode);
  const first = spawn("crash");
  let second: ReturnType<typeof spawn> | undefined;
  try {
    const reader = first.stdout.getReader();
    // The fixture starts Bun and connects to the database first; a loaded CI runner took over 3s.
    const ready = await Promise.race([
      reader.read(),
      Bun.sleep(10_000).then(() => {
        throw new Error("refresh fixture did not reach the provider");
      }),
    ]);
    expect(new TextDecoder().decode(ready.value)).toContain("provider rotated");
    first.kill("SIGKILL");
    await first.exited;
    expect(await storedRefresh(db, home)).toBe("synthetic-refresh-old");
    second = spawn("recover");
    expect(await second.exited).toBe(0);
    expect(await new Response(second.stderr).text()).toBe("");
    expect(bodies).toEqual(["synthetic-refresh-old", "synthetic-refresh-old"]);
    expect(await storedRefresh(db, home)).toBe("synthetic-refresh-rotated");
    const jobs = await listJobs(db);
    expect(jobs.map((job) => ({ status: job.status, attempts: job.attempts }))).toEqual([
      { status: "done", attempts: 2 },
    ]);
    const credentials = await db.run((q) => q.all(q.orm.select().from(q.t.credential)));
    expect(credentials).toHaveLength(1);
    const artifacts = [
      JSON.stringify(credentials),
      JSON.stringify(jobs),
      ...readdirSync(join(home, "secrets"))
        .filter((name) => name !== ".envelope-key")
        .map((name) => readFileSync(join(home, "secrets", name)).toString()),
    ];
    for (const bytes of artifacts)
      for (const value of [
        "synthetic-access-old",
        "synthetic-refresh-old",
        "synthetic-access-rotated",
        "synthetic-refresh-rotated",
        "synthetic-client-secret",
      ])
        expect(bytes).not.toContain(value);
  } finally {
    first.kill();
    second?.kill();
    await provider.stop(true);
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);

test("refresh failures keep the prior token and persist only a sanitized retry error", async () => {
  const home = tempHome();
  const { db, close } = await tempStore();
  const secretsDir = await initial(db, home);
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
    expect((await readStoredToken(db, secretsDir))?.refreshToken).toBe("synthetic-refresh-old");
    expect((await listJobs(db))[0]?.lastError).toBe("Integration token refresh failed.");
    expect((await listJobs(db))[0]?.status).toBe("pending");
  } finally {
    await close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("after one process refreshes, another process's next call uses the new token", async () => {
  const home = tempHome();
  const server = await pgliteServer();
  const db = server.store;
  await writeStoredToken(db, join(home, "secrets"), {
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
    const other = spawnRefresh(home, server.url, provider.port!, "recover");
    expect(await other.exited).toBe(0);
    expect(await auth.ensureFresh()).toBe("acme-access-new");
    expect((await readStoredToken(db, replicaSecrets))?.refreshToken).toBe("acme-refresh-new");
    expect(requests).toBe(0);
  } finally {
    await provider.stop(true);
    await server.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(replica, { recursive: true, force: true });
  }
}, 20_000);
