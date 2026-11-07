import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Clock } from "../src/core";
import {
  beginImplementRun,
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
} from "../src/db";
import { Orchestrator } from "../src/loop";
import { tempHome } from "./helpers";

type LiveTurn = { controller: AbortController; finish(): void };

const clock: Clock = { now: () => Date.now(), mono: () => performance.now() };

function paws(path: string, root: string, name: string) {
  const db = openDatabase(path);
  const self = registerInstance(db, {
    role: "all",
    host: `acme-${name}`,
    version: null,
    now: Date.now(),
  });
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
  const timer = setInterval(() => orchestrator.deliverInstanceCommands(), COMMAND_DELIVERY_MS);
  return {
    db,
    id: self.id,
    orchestrator,
    startTurn(itemId: string): LiveTurn {
      const turn = (
        orchestrator as unknown as { beginLive(itemId: string, key: string): LiveTurn }
      ).beginLive(itemId, `operation:${itemId}`);
      turn.controller.signal.addEventListener("abort", () => turn.finish(), { once: true });
      return turn;
    },
    close() {
      clearInterval(timer);
      db.close();
    },
  };
}

function twoInstances() {
  const root = tempHome();
  const path = join(root, "paws.db");
  const setup = openDatabase(path);
  migrate(setup);
  setup.close();
  return { a: paws(path, root, "a"), b: paws(path, root, "b") };
}

function runningItem(db: Database, id: string, owner: string): void {
  insertQueuedItem(db, { id, sessionKey: `${id}-session`, now: Date.now() });
  const { run } = beginImplementRun(db, id, Date.now());
  claimRun(db, run.id, owner);
}

function stop(db: Database, orchestrator: Orchestrator, itemId: string) {
  return submitCommand(db, orchestrator.bus, {
    type: "stop",
    source: "dashboard",
    itemId,
    requestedAt: Date.now(),
  });
}

test("a stop received by instance B aborts the turn on instance A, which owns the run, within 2 s", async () => {
  const { a, b } = twoInstances();
  try {
    runningItem(a.db, "acme-1", a.id);
    const turn = a.startTurn("acme-1");
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

test("a stop for a run on the receiving instance aborts its turn at once and addresses no one else", () => {
  const { a, b } = twoInstances();
  try {
    runningItem(a.db, "acme-2", a.id);
    const turn = a.startTurn("acme-2");

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
