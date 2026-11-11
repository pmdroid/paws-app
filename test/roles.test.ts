import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadRuntime } from "../src/config";
import { OUTBOX_ACTIVITY } from "../src/core";
import {
  enqueueJobOnce,
  enqueueOutbox,
  migrate,
  openDatabase,
  registerInstance,
  startLoops,
  type InstanceRole,
  sqliteDb,
} from "../src/db";
import { createInboxStore, createIntakePollSource, startCatchUpPoller } from "../src/linear";
import { tempHome } from "./helpers";

const ROOT = new URL("..", import.meta.url).pathname;

function spawnPaws(home: string, role: InstanceRole) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PAWS_HOME: home,
    PAWS_PORT: "0",
    PAWS_HOST: "127.0.0.1",
    PAWS_ROLE: role,
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

function sharedDatabase() {
  const path = join(tempHome(), "paws.db");
  const first = openDatabase(path);
  migrate(first);
  return { first, second: openDatabase(path) };
}

function recurringQueues(db: ReturnType<typeof openDatabase>): string[] {
  return db
    .query<{ queue: string }, []>(
      "SELECT queue FROM job WHERE recurring_every_ms IS NOT NULL ORDER BY queue",
    )
    .all()
    .map((row) => row.queue);
}

async function waitFor(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !done(); attempt++) await Bun.sleep(5);
}

describe("roles", () => {
  test("PAWS_ROLE defaults to all and refuses an unknown role", () => {
    const home = tempHome();
    expect(loadRuntime({ PAWS_HOME: home }).role).toBe("all");
    expect(loadRuntime({ PAWS_HOME: home, PAWS_ROLE: "worker" }).role).toBe("worker");
    expect(() => loadRuntime({ PAWS_HOME: home, PAWS_ROLE: "acme" })).toThrow(
      "PAWS_ROLE must be one of all, web, worker, got acme",
    );
  });

  test("a web and a worker instance run a recurring job once per interval", async () => {
    const { first, second } = sharedDatabase();
    const now = Date.now();
    const web = await registerInstance(sqliteDb(first), {
      role: "web",
      host: "acme-web",
      version: null,
      now,
    });
    const worker = await registerInstance(sqliteDb(second), {
      role: "worker",
      host: "acme-worker",
      version: null,
      now,
    });
    const runs: string[] = [];
    const controller = new AbortController();
    const start = (db: typeof first, id: string, role: InstanceRole) =>
      startLoops({
        db,
        instanceId: id,
        role,
        signal: controller.signal,
        prepare({ jobs }) {
          jobs.register("acme.catalog.refresh", () => {
            runs.push(role);
          });
          enqueueJobOnce(db, {
            queue: "acme.catalog.refresh",
            jobKey: "acme.catalog.refresh",
            recurringEveryMs: 600_000,
            now: Date.now(),
          });
        },
      });
    const loops = await Promise.all([
      start(first, web.id, "web"),
      start(second, worker.id, "worker"),
    ]);
    await waitFor(() => runs.length > 0);
    await Bun.sleep(50);
    controller.abort();
    await Promise.all(loops.map((loop) => loop.stop()));
    expect(runs).toEqual(["worker"]);
    expect(recurringQueues(first)).toEqual(["acme.catalog.refresh"]);
    first.close();
    second.close();
  });

  test("recurring jobs are pruned only when no other live instance runs jobs", async () => {
    const { first, second } = sharedDatabase();
    const now = Date.now();
    const self = await registerInstance(sqliteDb(first), {
      role: "all",
      host: "acme-a",
      version: null,
      now,
    });
    for (const queue of ["acme.kept", "acme.legacy"])
      enqueueJobOnce(first, { queue, jobKey: queue, recurringEveryMs: 600_000, now: now + 60_000 });
    const run = async (role: InstanceRole) => {
      const controller = new AbortController();
      const loops = await startLoops({
        db: first,
        instanceId: self.id,
        role,
        signal: controller.signal,
        prepare({ jobs }) {
          jobs.register("acme.kept", () => undefined);
        },
      });
      await Bun.sleep(20);
      controller.abort();
      await loops.stop();
    };

    await registerInstance(sqliteDb(second), {
      role: "worker",
      host: "acme-b",
      version: null,
      now,
    });
    await run("all");
    expect(recurringQueues(first)).toEqual(["acme.kept", "acme.legacy"]);

    second.run("UPDATE instance SET role = 'web' WHERE id != ?", [self.id]);
    await run("web");
    expect(recurringQueues(first)).toEqual(["acme.kept", "acme.legacy"]);

    await run("all");
    expect(recurringQueues(first)).toEqual(["acme.kept"]);
    first.close();
    second.close();
  });

  test("a web process beside a worker claims nothing and keeps the worker's recurring jobs", async () => {
    const home = tempHome();
    const worker = spawnPaws(home, "worker");
    let web: ReturnType<typeof spawnPaws> | undefined;
    try {
      const workerUrl = await readyUrl(worker);
      const db = openDatabase(join(home, "paws.db"));
      try {
        enqueueJobOnce(db, {
          queue: "acme.worker-only",
          jobKey: "acme.worker-only",
          recurringEveryMs: 600_000,
          now: Date.now() + 600_000,
        });
        web = spawnPaws(home, "web");
        const webUrl = await readyUrl(web);
        const health = (await (await fetch(`${webUrl}/health`)).json()) as {
          instances: { role: string }[];
          checks: { jobProgress?: { status: string; reason?: string } };
        };
        expect(health.instances.map((live) => live.role).sort()).toEqual(["web", "worker"]);
        expect(health.checks.jobProgress).toEqual({ status: "skipped", reason: "not_observed" });
        expect((await fetch(`${workerUrl}/health`)).ok).toBe(true);

        const queues = recurringQueues(db);
        expect(queues).toContain("acme.worker-only");
        for (const queue of [
          "repository.catalog.refresh",
          "agent.catalog.refresh",
          "skills.updates.check",
        ])
          expect(queues.filter((name) => name === queue)).toEqual([queue]);
        const claims = db
          .query<{ locked_by: string }, []>(
            "SELECT DISTINCT locked_by FROM job WHERE locked_by IS NOT NULL",
          )
          .all();
        const webId = db
          .query<{ id: string }, []>("SELECT id FROM instance WHERE role = 'web'")
          .get()!.id;
        expect(claims.filter((claim) => claim.locked_by.startsWith(webId))).toEqual([]);
      } finally {
        db.close();
      }
    } finally {
      worker.kill("SIGKILL");
      web?.kill("SIGKILL");
    }
  }, 40_000);
  test("two instances' catch-up pollers share one due time and poll once per interval", async () => {
    const { first, second } = sharedDatabase();
    let clock = 1_700_000_000_000;
    let requests = 0;
    const source = createIntakePollSource(
      {
        async query() {
          requests += 1;
          return {
            viewer: { id: "acme-app" },
            issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            agentActivities: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          };
        },
      },
      { teamId: "acme-team" },
    );
    const [web, worker] = [first, second].map((db) =>
      startCatchUpPoller({
        source,
        store: createInboxStore(sqliteDb(db)),
        onEvent: () => {},
        timer: false,
        now: () => clock,
      }),
    );
    await web!.pollDue();
    const afterFirst = requests;
    await worker!.pollDue();
    expect(afterFirst).toBeGreaterThan(0);
    expect(requests).toBe(afterFirst);
    clock += 60_000;
    await worker!.pollDue();
    expect(requests).toBeGreaterThan(afterFirst);
    await Promise.all([web!.stop(), worker!.stop()]);
    first.close();
    second.close();
  });

  test("a second worker leaves a refresh that already ran for its next interval", async () => {
    const home = tempHome();
    const first = spawnPaws(home, "worker");
    let second: ReturnType<typeof spawnPaws> | undefined;
    const db = openDatabase(join(home, "paws.db"));
    const runAt = () =>
      db
        .query<{ run_at: number; status: string }, []>(
          "SELECT run_at, status FROM job WHERE queue = 'repository.catalog.refresh'",
        )
        .get();
    try {
      await readyUrl(first);
      await waitFor(() => (runAt()?.run_at ?? 0) > Date.now() + 60_000);
      const scheduled = runAt();
      expect(scheduled?.status).toBe("pending");
      second = spawnPaws(home, "worker");
      await readyUrl(second);
      await Bun.sleep(1_500);
      expect(runAt()).toEqual(scheduled);
    } finally {
      db.close();
      first.kill("SIGKILL");
      second?.kill("SIGKILL");
    }
  }, 40_000);
  test("a web instance's outbox claims nothing, even on a direct tick", async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    enqueueOutbox(db, {
      target: OUTBOX_ACTIVITY.target,
      op: OUTBOX_ACTIVITY.op,
      orderingKey: "acme-session",
      payload: {},
      idempotencyKey: "acme-web-1",
    });
    const delivered: number[] = [];
    const run = async (role: InstanceRole) => {
      const controller = new AbortController();
      const loops = await startLoops({
        db,
        instanceId: `01JACME${role.toUpperCase()}`,
        role,
        signal: controller.signal,
        prepare({ outbox }) {
          outbox.setHandler((row) => {
            delivered.push(row.id);
          });
        },
      });
      const claimed = await loops.outbox.tick();
      if (role !== "web") await waitFor(() => delivered.length > 0);
      await loops.outbox.idle();
      controller.abort();
      await loops.stop();
      return claimed.length;
    };
    expect(await run("web")).toBe(0);
    expect(delivered).toEqual([]);
    await run("all");
    expect(delivered).toHaveLength(1);
    db.close();
  });
});
