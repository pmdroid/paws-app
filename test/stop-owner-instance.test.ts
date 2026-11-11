import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { JOB_KIND, type Clock } from "../src/core";
import {
  applyLinearCommand,
  applyWorkItemEvent,
  beginImplementRun,
  bindInstance,
  claimRun,
  commandDeliveryQueue,
  COMMAND_DELIVERY_MS,
  enqueueCommand,
  getWorkItem,
  insertQueuedItem,
  JobLoop,
  listJobs,
  migrate,
  openDatabase,
  OutboxDispatcher,
  registerInstance,
  submitCommand,
  sqliteDb,
} from "../src/db";
import { Orchestrator } from "../src/loop";
import { tempHome } from "./helpers";

type LiveTurn = { controller: AbortController; finish(): void };

const clock: Clock = { now: () => Date.now(), mono: () => performance.now() };

async function paws(path: string, root: string, name: string, poll = true) {
  const db = openDatabase(path);
  const self = await registerInstance(sqliteDb(db), {
    role: "all",
    host: `acme-${name}`,
    version: null,
    now: Date.now(),
  });
  bindInstance(sqliteDb(db), self.id);
  const orchestrator = new Orchestrator({
    store: sqliteDb(db),
    jobs: new JobLoop(db, clock),
    clock,
    outbox: new OutboxDispatcher(db, clock),
    pawsRoot: join(root, name),
    home: join(root, name),
    instanceId: self.id,
    launch: () => {
      throw new Error("The test starts the turn itself");
    },
  });
  const timer = poll
    ? setInterval(() => orchestrator.deliverInstanceCommands(), COMMAND_DELIVERY_MS)
    : undefined;
  return {
    db,
    id: self.id,
    orchestrator,
    async startTurn(itemId: string, key = `operation:${itemId}`): Promise<LiveTurn> {
      const turn = await (
        orchestrator as unknown as { beginLive(itemId: string, key: string): Promise<LiveTurn> }
      ).beginLive(itemId, key);
      turn.controller.signal.addEventListener("abort", () => turn.finish(), { once: true });
      return turn;
    },
    close() {
      clearInterval(timer);
      db.close();
    },
  };
}

async function twoInstances(poll = true) {
  const root = tempHome();
  const path = join(root, "paws.db");
  const setup = openDatabase(path);
  migrate(setup);
  setup.close();
  return { a: await paws(path, root, "a", poll), b: await paws(path, root, "b", poll) };
}

async function runningItem(db: Database, id: string, owner: string): Promise<void> {
  insertQueuedItem(db, { id, sessionKey: `${id}-session`, now: Date.now() });
  const { run } = await beginImplementRun(sqliteDb(db), id, Date.now());
  await claimRun(sqliteDb(db), run.id, owner);
}

async function stop(
  db: Database,
  orchestrator: Orchestrator,
  itemId: string,
  source: "dashboard" | "linear" = "dashboard",
) {
  return submitCommand(sqliteDb(db), orchestrator.bus, {
    type: "stop",
    source,
    itemId,
    requestedAt: Date.now(),
  });
}

test("a stop received by instance B aborts the turn on instance A, which owns the run, within 2 s", async () => {
  const { a, b } = await twoInstances();
  try {
    await runningItem(a.db, "acme-1", a.id);
    const turn = await a.startTurn("acme-1");
    const started = performance.now();

    expect(await stop(b.db, b.orchestrator, "acme-1")).toEqual({ applied: true });
    expect((await getWorkItem(sqliteDb(b.db), "acme-1"))?.state).toBe("cancelled");
    expect(turn.controller.signal.aborted).toBe(false);

    await new Promise<void>((resolve) =>
      turn.controller.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    expect(performance.now() - started).toBeLessThan(2_000);
    const deliveries = (await listJobs(sqliteDb(a.db))).filter(
      (job) => job.queue === commandDeliveryQueue(a.id),
    );
    expect(deliveries.map((job) => job.status)).toEqual(["done"]);
    expect(
      (await listJobs(sqliteDb(a.db))).some((job) => job.queue === commandDeliveryQueue(b.id)),
    ).toBe(false);
  } finally {
    a.close();
    b.close();
  }
});

test("a stop for a run on the receiving instance aborts its turn at once and addresses no one else", async () => {
  const { a, b } = await twoInstances();
  try {
    await runningItem(a.db, "acme-2", a.id);
    const turn = await a.startTurn("acme-2");

    expect(await stop(a.db, a.orchestrator, "acme-2")).toEqual({ applied: true });
    expect(turn.controller.signal.aborted).toBe(true);
    expect(
      (await listJobs(sqliteDb(a.db))).filter(
        (job) =>
          job.queue === commandDeliveryQueue(a.id) || job.queue === commandDeliveryQueue(b.id),
      ),
    ).toEqual([]);
  } finally {
    a.close();
    b.close();
  }
});

test("the owner's delivery row commits with the stop itself, before any bus emits", async () => {
  const { a, b } = await twoInstances(false);
  try {
    await runningItem(a.db, "acme-3", a.id);
    const command = {
      type: "stop" as const,
      source: "dashboard" as const,
      itemId: "acme-3",
      requestedAt: Date.now(),
    };
    expect(await applyLinearCommand(sqliteDb(b.db), command)).toEqual({ applied: true });
    const delivery = (await listJobs(sqliteDb(a.db))).filter(
      (job) => job.queue === commandDeliveryQueue(a.id),
    );
    expect(delivery.map((job) => job.status)).toEqual(["pending"]);
    expect(delivery[0]?.payload).toEqual({
      command,
      stoppedAtVersion: (await getWorkItem(sqliteDb(a.db), "acme-3"))!.version,
    });
  } finally {
    a.close();
    b.close();
  }
});

test("a delayed stop aborts the turn it stopped and leaves a turn started after a resume", async () => {
  const { a, b } = await twoInstances(false);
  try {
    await runningItem(a.db, "acme-4", a.id);
    const stopped = await a.startTurn("acme-4", "acme-4-old");
    expect(await stop(b.db, b.orchestrator, "acme-4", "linear")).toEqual({ applied: true });
    expect((await getWorkItem(sqliteDb(b.db), "acme-4"))?.state).toBe("paused");
    await applyWorkItemEvent(sqliteDb(b.db), "acme-4", "resume");
    const replacement = await a.startTurn("acme-4", "acme-4-new");

    expect(await a.orchestrator.deliverInstanceCommands()).toBe(1);
    expect(stopped.controller.signal.aborted).toBe(true);
    expect(replacement.controller.signal.aborted).toBe(false);
  } finally {
    a.close();
    b.close();
  }
});

test("a queued stop forwards to the run's owner through the store the orchestrator is bound to", async () => {
  const { a } = await twoInstances(false);
  const root = tempHome();
  const db = openDatabase(join(a.db.filename));
  const store = { ...sqliteDb(db) };
  const self = await registerInstance(store, {
    role: "all",
    host: "acme-store",
    version: null,
    now: Date.now(),
  });
  bindInstance(store, self.id);
  const jobs = new JobLoop(db, clock, { store });
  const orchestrator = new Orchestrator({
    store,
    jobs,
    clock,
    outbox: new OutboxDispatcher(db, clock, { store }),
    pawsRoot: join(root, "store"),
    home: join(root, "store"),
    instanceId: self.id,
    launch: () => {
      throw new Error("The test starts no turn");
    },
  });
  try {
    await runningItem(a.db, "acme-5", a.id);
    enqueueCommand(db, {
      type: "stop",
      source: "dashboard",
      itemId: "acme-5",
      requestedAt: Date.now(),
    });
    expect((await jobs.tick([JOB_KIND.command]))?.queue).toBe(JOB_KIND.command);
    expect(orchestrator.store).toBe(store);
    expect((await getWorkItem(sqliteDb(db), "acme-5"))?.state).toBe("cancelled");
    const deliveries = (await listJobs(sqliteDb(db))).filter(
      (job) => job.queue === commandDeliveryQueue(a.id),
    );
    expect(deliveries.map((job) => job.status)).toEqual(["pending"]);
  } finally {
    a.close();
    db.close();
  }
});
