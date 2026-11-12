import { describe, expect, test } from "bun:test";
import { OUTBOX_ACTIVITY } from "../src/core";
import {
  enqueueJob,
  enqueueOutbox,
  heartbeatInstance,
  INSTANCE_DEAD_MS,
  liveInstances,
  openPawsStore,
  registerInstance,
  startLoops,
} from "../src/db";
import { tempHome } from "./helpers";
import { pgliteServer, tempStore } from "./pglite";

const ROOT = new URL("..", import.meta.url).pathname;

function spawnPaws(home: string, url: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PAWS_DATABASE_URL: url,
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
    const server = await pgliteServer();
    const first = spawnPaws(home, server.url);
    const firstUrl = await readyUrl(first);
    const second = spawnPaws(home, server.url);
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

      const db = server.store;
      {
        const rows = await db.run((q) =>
          q.all(
            q.orm
              .select({
                id: q.t.instance.id,
                heartbeat_at: q.t.instance.heartbeatAt,
                stopped_at: q.t.instance.stoppedAt,
              })
              .from(q.t.instance),
          ),
        );
        // A clean stop keeps the row and its last heartbeat for the lease downtime credit.
        const stopped = rows.find((row) => row.id === firstHealth.instance)!;
        expect(stopped.stopped_at).toBe(stopped.heartbeat_at);
        const killed = rows.find((row) => row.id === secondHealth.instance)!;
        expect(killed.stopped_at).toBeNull();
        const killedAt = killed.heartbeat_at;
        expect(
          (await liveInstances(db, killedAt + INSTANCE_DEAD_MS - 1)).map((row) => row.id),
        ).toEqual([secondHealth.instance]);
        expect(await liveInstances(db, killedAt + INSTANCE_DEAD_MS)).toEqual([]);
      }
    } finally {
      first.kill("SIGKILL");
      second.kill("SIGKILL");
      await server.close();
    }
  }, 40_000);

  test("a heartbeat keeps one instance live while the other expires", async () => {
    const server = await pgliteServer();
    const acme = server.store;
    const other = await openPawsStore({ url: server.url, pgliteDir: "" });
    try {
      const a = await registerInstance(acme, {
        role: "all",
        host: "acme-a",
        version: null,
        now: 0,
      });
      const b = await registerInstance(other.store, {
        role: "all",
        host: "acme-b",
        version: "0.1.2",
        now: 0,
      });
      expect(await heartbeatInstance(acme, a.id, 50_000)).toBe(true);
      expect((await liveInstances(other.store, 59_999)).map((row) => row.id)).toEqual([a.id, b.id]);
      expect((await liveInstances(other.store, 60_000)).map((row) => row.id)).toEqual([a.id]);
      expect(await heartbeatInstance(acme, "01JACMEGONE00000000000000", 60_000)).toBe(false);
    } finally {
      await other.close();
      await server.close();
    }
  });

  test("job and outbox claims record the instance id", async () => {
    const { db, close } = await tempStore();
    const instance = await registerInstance(db, {
      role: "all",
      host: "acme",
      version: null,
      now: Date.now(),
    });
    await enqueueJob(db, { queue: "acme.work", now: Date.now() });
    await enqueueOutbox(db, {
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
    await close();
    expect(claims.job?.startsWith(`${instance.id}:`)).toBe(true);
    expect(claims.outbox).toBe(`outbox:${instance.id}`);
  });
});
