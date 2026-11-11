import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Clock } from "../src/core";
import {
  applyLinearCommand,
  applyWorkItemEvent,
  beginImplementRun,
  bindInstance,
  claimRun,
  commandDeliveryQueue,
  COMMAND_DELIVERY_MS,
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

function paws(path: string, root: string, name: string, poll = true) {
  const db = openDatabase(path);
  const self = registerInstance(db, {
    role: "all",
    host: `acme-${name}`,
    version: null,
    now: Date.now(),
  });
  bindInstance(db, self.id);
  const orchestrator = new Orchestrator({
    db,
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

function twoInstances(poll = true) {
  const root = tempHome();
  const path = join(root, "paws.db");
  const setup = openDatabase(path);
  migrate(setup);
  setup.close();
  return { a: paws(path, root, "a", poll), b: paws(path, root, "b", poll) };
}

async function runningItem(db: Database, id: string, owner: string): Promise<void> {
  insertQueuedItem(db, { id, sessionKey: `${id}-session`, now: Date.now() });
  const { run } = beginImplementRun(db, id, Date.now());
  await claimRun(sqliteDb(db), run.id, owner);
}

function stop(
  db: Database,
  orchestrator: Orchestrator,
  itemId: string,
  source: "dashboard" | "linear" = "dashboard",
) {
  return submitCommand(db, orchestrator.bus, {
    type: "stop",
    source,
    itemId,
    requestedAt: Date.now(),
  });
}

test("a stop received by instance B aborts the turn on instance A, which owns the run, within 2 s", async () => {
  const { a, b } = twoInstances();
  try {
    await runningItem(a.db, "acme-1", a.id);
    const turn = await a.startTurn("acme-1");
    const started = performance.now();

    expect(stop(b.db, b.orchestrator, "acme-1")).toEqual({ applied: true });
    expect(getWorkItem(b.db, "acme-1")?.state).toBe("cancelled");
    expect(turn.controller.signal.aborted).toBe(false);

    await new Promise<void>((resolve) =>
      turn.controller.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    expect(performance.now() - started).toBeLessThan(2_000);
    const deliveries = listJobs(a.db).filter((job) => job.queue === commandDeliveryQueue(a.id));
    expect(deliveries.map((job) => job.status)).toEqual(["done"]);
    expect(listJobs(a.db).some((job) => job.queue === commandDeliveryQueue(b.id))).toBe(false);
  } finally {
    a.close();
    b.close();
  }
});

test("a stop for a run on the receiving instance aborts its turn at once and addresses no one else", async () => {
  const { a, b } = twoInstances();
  try {
    await runningItem(a.db, "acme-2", a.id);
    const turn = await a.startTurn("acme-2");

    expect(stop(a.db, a.orchestrator, "acme-2")).toEqual({ applied: true });
    expect(turn.controller.signal.aborted).toBe(true);
    expect(
      listJobs(a.db).filter(
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
  const { a, b } = twoInstances(false);
  try {
    await runningItem(a.db, "acme-3", a.id);
    const command = {
      type: "stop" as const,
      source: "dashboard" as const,
      itemId: "acme-3",
      requestedAt: Date.now(),
    };
    expect(applyLinearCommand(b.db, command)).toEqual({ applied: true });
    const delivery = listJobs(a.db).filter((job) => job.queue === commandDeliveryQueue(a.id));
    expect(delivery.map((job) => job.status)).toEqual(["pending"]);
    expect(delivery[0]?.payload).toEqual({
      command,
      stoppedAtVersion: getWorkItem(a.db, "acme-3")!.version,
    });
  } finally {
    a.close();
    b.close();
  }
});

test("a delayed stop aborts the turn it stopped and leaves a turn started after a resume", async () => {
  const { a, b } = twoInstances(false);
  try {
    await runningItem(a.db, "acme-4", a.id);
    const stopped = await a.startTurn("acme-4", "acme-4-old");
    expect(stop(b.db, b.orchestrator, "acme-4", "linear")).toEqual({ applied: true });
    expect(getWorkItem(b.db, "acme-4")?.state).toBe("paused");
    applyWorkItemEvent(b.db, "acme-4", "resume");
    const replacement = await a.startTurn("acme-4", "acme-4-new");

    expect(a.orchestrator.deliverInstanceCommands()).toBe(1);
    expect(stopped.controller.signal.aborted).toBe(true);
    expect(replacement.controller.signal.aborted).toBe(false);
  } finally {
    a.close();
    b.close();
  }
});
