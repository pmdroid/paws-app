import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createLinearAuth, readStoredToken, writeStoredToken } from "../src/linear";
import { claimNextJob, completeJob, listJobs, migrate, openDatabase } from "../src/db";
import { refreshCredential } from "../src/credentials";
import { tempHome } from "./helpers";

function initial(home: string): string {
  const path = join(home, "secrets", "linear-oauth.json");
  mkdirSync(join(home, "secrets"), { recursive: true });
  writeStoredToken(path, {
    accessToken: "synthetic-access-old",
    refreshToken: "synthetic-refresh-old",
    expiresAtMs: 0,
    scope: "read,write",
    actor: "app",
  });
  return path;
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
      read() {
        const snapshot = stored;
        if (++reads === 2) {
          const job = claimNextJob(db, { workerId: "competing-refresh" });
          expect(job).not.toBeNull();
          stored = rotated;
          expect(completeJob(db, job!)).toBe(true);
        }
        return snapshot;
      },
      write(credential) {
        stored = credential;
      },
      async refresh() {
        throw new Error("The competing worker already refreshed the credential.");
      },
    });
    expect(value).toEqual(rotated);
    expect(listJobs(db).map((job) => job.status)).toEqual(["done"]);
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("separate Linear clients share one durable refresh job and rotate the encrypted token", async () => {
  const home = tempHome();
  const path = initial(home);
  const db = openDatabase(join(home, "paws.db"));
  migrate(db);
  let requests = 0;
  const options = {
    db,
    tokenPath: path,
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
    const clients = Array.from({ length: 5 }, () => createLinearAuth(options));
    expect(await Promise.all(clients.map((client) => client.ensureFresh()))).toEqual(
      Array(5).fill("synthetic-access-new"),
    );
    expect(requests).toBe(1);
    expect(listJobs(db).map((job) => job.status)).toEqual(["done"]);
    expect(readStoredToken(path)?.refreshToken).toBe("synthetic-refresh-new");
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a killed refresh process replays the consumed Linear token after restart and persists its rotation", async () => {
  const home = tempHome();
  const path = initial(home);
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
  const spawn = (mode: string) =>
    Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        new URL("./fixtures/credential-refresh.ts", import.meta.url).pathname,
        home,
        `http://127.0.0.1:${provider.port}/token`,
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
  const first = spawn("crash");
  let second: ReturnType<typeof spawn> | undefined;
  try {
    const reader = first.stdout.getReader();
    const ready = await Promise.race([
      reader.read(),
      Bun.sleep(3_000).then(() => {
        throw new Error("refresh fixture did not reach the provider");
      }),
    ]);
    expect(new TextDecoder().decode(ready.value)).toContain("provider rotated");
    first.kill("SIGKILL");
    await first.exited;
    expect(readStoredToken(path)?.refreshToken).toBe("synthetic-refresh-old");
    second = spawn("recover");
    expect(await second.exited).toBe(0);
    expect(await new Response(second.stderr).text()).toBe("");
    expect(bodies).toEqual(["synthetic-refresh-old", "synthetic-refresh-old"]);
    expect(readStoredToken(path)?.refreshToken).toBe("synthetic-refresh-rotated");
    const db = openDatabase(join(home, "paws.db"));
    expect(listJobs(db).map((job) => ({ status: job.status, attempts: job.attempts }))).toEqual([
      { status: "done", attempts: 2 },
    ]);
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
  const path = initial(home);
  const db = openDatabase(join(home, "paws.db"));
  migrate(db);
  try {
    const auth = createLinearAuth({
      db,
      tokenPath: path,
      clientId: "synthetic-client",
      clientSecret: "synthetic-client-secret",
      fetch: async () => {
        throw new Error("synthetic-refresh-old synthetic-client-secret");
      },
    });
    await expect(auth.ensureFresh()).rejects.toThrow("Integration token refresh failed");
    expect(readStoredToken(path)?.refreshToken).toBe("synthetic-refresh-old");
    expect(listJobs(db)[0]?.lastError).toBe("Integration token refresh failed.");
    expect(listJobs(db)[0]?.status).toBe("pending");
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});
