import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { OUTBOX_ACTIVITY } from "../src/core";
import {
  enqueueJob,
  enqueueOutbox,
  heartbeatInstance,
  INSTANCE_DEAD_MS,
  liveInstances,
  migrate,
  openDatabase,
  registerInstance,
  startLoops,
  sqliteDb,
} from "../src/db";
import { tempHome } from "./helpers";

const ROOT = new URL("..", import.meta.url).pathname;

function spawnPaws(home: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PAWS_HOME: home,
    PAWS_PORT: "0",
    PAWS_HOST: "127.0.0.1",
  };
  for (const key of Object.keys(env))
    if (key.startsWith("LINEAR_") || key === "PAWS_EXECUTION" || key === "PAWS_PUBLIC_URL")
      delete env[key];
  return Bun.spawn(["bun", "src/index.ts"], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
}

async function readyUrl(proc: ReturnType<typeof spawnPaws>): Promise<string> {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const match = /paws ready · (http:\/\/127\.0\.0\.1:\d+)/.exec(text);
    if (match) {
      reader.releaseLock();
      return match[1]!;
    }
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
  }
  throw new Error(`Paws did not print ready: ${text}`);
}

type HealthBody = {
  instance: string;
  instances: { id: string; role: string; version: string | null }[];
};

describe("instances", () => {
  test("two processes on one database register, list each other, stop and expire", async () => {
    const home = tempHome();
    const first = spawnPaws(home);
    const firstUrl = await readyUrl(first);
    const second = spawnPaws(home);
    try {
      const secondUrl = await readyUrl(second);
      const firstHealth = (await (await fetch(`${firstUrl}/health`)).json()) as HealthBody;
      const secondHealth = (await (await fetch(`${secondUrl}/health`)).json()) as HealthBody;
      expect(firstHealth.instance).not.toBe(secondHealth.instance);
      for (const body of [firstHealth, secondHealth])
        expect(body.instances.map((live) => live.id).sort()).toEqual(
          [firstHealth.instance, secondHealth.instance].sort(),
        );
      expect(firstHealth.instances.every((live) => live.role === "all")).toBe(true);
      for (const live of firstHealth.instances) expect(live.version).toMatch(/^git:[0-9a-f]{12}$/);

      first.kill("SIGTERM");
      await first.exited;
      second.kill("SIGKILL");
      await second.exited;

      const db = openDatabase(join(home, "paws.db"));
      try {
        const rows = db
          .query<{ id: string; heartbeat_at: number; stopped_at: number | null }, []>(
            "SELECT id, heartbeat_at, stopped_at FROM instance",
          )
          .all();
        // A clean stop keeps the row and its last heartbeat for the lease downtime credit.
        const stopped = rows.find((row) => row.id === firstHealth.instance)!;
        expect(stopped.stopped_at).toBe(stopped.heartbeat_at);
        const killed = rows.find((row) => row.id === secondHealth.instance)!;
        expect(killed.stopped_at).toBeNull();
        const killedAt = killed.heartbeat_at;
        expect(
          (await liveInstances(sqliteDb(db), killedAt + INSTANCE_DEAD_MS - 1)).map((row) => row.id),
        ).toEqual([secondHealth.instance]);
        expect(await liveInstances(sqliteDb(db), killedAt + INSTANCE_DEAD_MS)).toEqual([]);
      } finally {
        db.close();
      }
    } finally {
      first.kill("SIGKILL");
      second.kill("SIGKILL");
    }
  }, 40_000);

  test("a heartbeat keeps one instance live while the other expires", async () => {
    const path = join(tempHome(), "paws.db");
    const acme = openDatabase(path);
    migrate(acme);
    const other = openDatabase(path);
    try {
      const a = registerInstance(acme, { role: "all", host: "acme-a", version: null, now: 0 });
      const b = registerInstance(other, { role: "all", host: "acme-b", version: "0.1.2", now: 0 });
      expect(await heartbeatInstance(sqliteDb(acme), a.id, 50_000)).toBe(true);
      expect((await liveInstances(sqliteDb(other), 59_999)).map((row) => row.id)).toEqual([
        a.id,
        b.id,
      ]);
      expect((await liveInstances(sqliteDb(other), 60_000)).map((row) => row.id)).toEqual([a.id]);
      expect(await heartbeatInstance(sqliteDb(acme), "01JACMEGONE00000000000000", 60_000)).toBe(
        false,
      );
    } finally {
      other.close();
      acme.close();
    }
  });

  test("job and outbox claims record the instance id", async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const instance = registerInstance(db, {
      role: "all",
      host: "acme",
      version: null,
      now: Date.now(),
    });
    enqueueJob(db, { queue: "acme.work", now: Date.now() });
    enqueueOutbox(db, {
      target: OUTBOX_ACTIVITY.target,
      op: OUTBOX_ACTIVITY.op,
      orderingKey: "acme-session",
      payload: {},
      idempotencyKey: "acme-1",
    });
    const claims: { job?: string | null; outbox?: string | null } = {};
    const controller = new AbortController();
    const loops = await startLoops({
      db,
      instanceId: instance.id,
      signal: controller.signal,
      prepare({ jobs, outbox }) {
        jobs.register("acme.work", async (job) => {
          claims.job = job.lockedBy;
        });
        outbox.setHandler((row) => {
          claims.outbox = row.lockedBy;
        });
      },
    });
    for (let attempt = 0; attempt < 400 && (!claims.job || !claims.outbox); attempt++)
      await Bun.sleep(5);
    controller.abort();
    await loops.stop();
    db.close();
    expect(claims.job?.startsWith(`${instance.id}:`)).toBe(true);
    expect(claims.outbox).toBe(`outbox:${instance.id}`);
  });
});
