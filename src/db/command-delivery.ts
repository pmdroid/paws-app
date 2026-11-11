import type { Database } from "bun:sqlite";
import { and, eq, gt, ne } from "drizzle-orm";
import { JOB_KIND, parseLinearCommand, type LinearCommand } from "../core";
import { journalCaught } from "../journal";
import { settled, sqliteDb, type Db, type Q, type Steps } from "./db";
import { INSTANCE_DEAD_MS } from "./instances";
import { getWorkItemSteps } from "./items";
import {
  claimNextJobSteps,
  completeJobSteps,
  emitJobReady,
  enqueueJobOnceSteps,
  type Job,
} from "./jobs";

export function commandDeliveryQueue(instanceId: string): string {
  return `${JOB_KIND.command}.deliver:${instanceId}`;
}

export const COMMAND_DELIVERY_MS = 1_000;

const boundInstances = new WeakMap<Db, string>();

export function commandInstance(source: Database | Db): string | undefined {
  return boundInstances.get("dialect" in source ? source : sqliteDb(source));
}

export function bindInstance(store: Db, instanceId: string): void {
  boundInstances.set(store, instanceId);
}

type DeliveredCommand = { command: LinearCommand; stoppedAtVersion: number };

export function* forwardCommandSteps(
  q: Q,
  self: string,
  command: LinearCommand,
  now: number,
): Steps<{ owners: string[]; inserted: boolean }> {
  const stoppedAtVersion = (yield* getWorkItemSteps(q, command.itemId))?.version;
  if (stoppedAtVersion === undefined) return { owners: [], inserted: false };
  const { instance, run, runOwner } = q.t;
  const owners = (yield* q.all(
    q.orm
      .selectDistinct({ id: runOwner.ownerInstance })
      .from(run)
      .innerJoin(runOwner, eq(runOwner.runId, run.id))
      .innerJoin(instance, eq(instance.id, runOwner.ownerInstance))
      .where(
        and(
          eq(run.itemId, command.itemId),
          ne(runOwner.ownerInstance, self),
          gt(instance.heartbeatAt, now - INSTANCE_DEAD_MS),
        ),
      ),
  )).map((row) => row.id);
  let inserted = false;
  for (const owner of owners) {
    const enqueued = yield* enqueueJobOnceSteps(q, {
      queue: commandDeliveryQueue(owner),
      jobKey: `cmd-deliver:${owner}:${command.type}:${command.itemId}:${command.requestedAt}`,
      priority: 0,
      payload: { command, stoppedAtVersion },
      now,
      runAt: now,
    });
    inserted ||= enqueued.inserted;
  }
  return { owners, inserted };
}

export async function forwardCommandAsync(
  store: Db,
  self: string,
  command: LinearCommand,
  now = Date.now(),
): Promise<string[]> {
  const { owners, inserted } = await store.transaction((q) =>
    forwardCommandSteps(q, self, command, now),
  );
  if (inserted) emitJobReady(store);
  return owners;
}

function deliveryOf(job: Job): DeliveredCommand | null {
  const payload = job.payload as { command?: unknown; stoppedAtVersion?: unknown } | null;
  const command = parseLinearCommand(payload?.command);
  const stoppedAtVersion = payload?.stoppedAtVersion;
  if (command === null || typeof stoppedAtVersion !== "number") return null;
  return { command, stoppedAtVersion };
}

function claimOptions(self: string, now: number) {
  return { workerId: "command-delivery", now, queues: [commandDeliveryQueue(self)] };
}

function deliverCommand(delivery: DeliveredCommand, deliver: (d: DeliveredCommand) => void) {
  try {
    deliver(delivery);
  } catch (error) {
    journalCaught(error, "commandDelivery.drainInstanceCommands.deliver", delivery.command.itemId);
  }
}

export function drainInstanceCommands(
  db: Database,
  self: string,
  deliver: (delivery: DeliveredCommand) => void,
  now = Date.now(),
): number {
  const store = sqliteDb(db);
  let delivered = 0;
  for (;;) {
    const job = settled(store.run((q) => claimNextJobSteps(q, claimOptions(self, now))));
    if (job === null) return delivered;
    const delivery = deliveryOf(job);
    if (!settled(store.run((q) => completeJobSteps(q, job, now))) || delivery === null) continue;
    deliverCommand(delivery, deliver);
    delivered += 1;
  }
}

export async function drainInstanceCommandsAsync(
  store: Db,
  self: string,
  deliver: (delivery: DeliveredCommand) => void,
  now = Date.now(),
): Promise<number> {
  let delivered = 0;
  for (;;) {
    const job = await store.run((q) => claimNextJobSteps(q, claimOptions(self, now)));
    if (job === null) return delivered;
    const delivery = deliveryOf(job);
    if (!(await store.run((q) => completeJobSteps(q, job, now))) || delivery === null) continue;
    deliverCommand(delivery, deliver);
    delivered += 1;
  }
}
