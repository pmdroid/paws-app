import type { Database } from "bun:sqlite";
import { and, eq, gt, ne } from "drizzle-orm";
import { JOB_KIND, parseLinearCommand, type LinearCommand } from "../core";
import { journalCaught } from "../journal";
import { INSTANCE_DEAD_MS } from "./instances";
import { getWorkItem } from "./items";
import { claimNextJob, completeJob, enqueueJobOnce } from "./jobs";
import { orm } from "./orm";
import { instance, run, runOwner } from "./schema";

export function commandDeliveryQueue(instanceId: string): string {
  return `${JOB_KIND.command}.deliver:${instanceId}`;
}

export const COMMAND_DELIVERY_MS = 1_000;

const boundInstances = new WeakMap<Database, string>();

export function bindInstance(db: Database, instanceId: string): void {
  boundInstances.set(db, instanceId);
}

type DeliveredCommand = { command: LinearCommand; stoppedAtVersion: number };

export function forwardCommand(db: Database, command: LinearCommand, now = Date.now()): string[] {
  const self = boundInstances.get(db);
  const stoppedAtVersion = getWorkItem(db, command.itemId)?.version;
  if (self === undefined || stoppedAtVersion === undefined) return [];
  const owners = orm(db)
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
    )
    .all()
    .map((row) => row.id);
  for (const owner of owners)
    enqueueJobOnce(db, {
      queue: commandDeliveryQueue(owner),
      jobKey: `cmd-deliver:${owner}:${command.type}:${command.itemId}:${command.requestedAt}`,
      priority: 0,
      payload: { command, stoppedAtVersion },
      now,
      runAt: now,
    });
  return owners;
}

export function drainInstanceCommands(
  db: Database,
  self: string,
  deliver: (delivery: DeliveredCommand) => void,
  now = Date.now(),
): number {
  let delivered = 0;
  for (;;) {
    const job = claimNextJob(db, {
      workerId: "command-delivery",
      now,
      queues: [commandDeliveryQueue(self)],
    });
    if (job === null) return delivered;
    const payload = job.payload as { command?: unknown; stoppedAtVersion?: unknown } | null;
    const command = parseLinearCommand(payload?.command);
    const stoppedAtVersion = payload?.stoppedAtVersion;
    if (!completeJob(db, job, now) || command === null || typeof stoppedAtVersion !== "number")
      continue;
    try {
      deliver({ command, stoppedAtVersion });
    } catch (error) {
      journalCaught(error, "commandDelivery.drainInstanceCommands.deliver", command.itemId);
    }
    delivered += 1;
  }
}
