import type { Database } from "bun:sqlite";
import { and, eq, gt, ne } from "drizzle-orm";
import { JOB_KIND, parseLinearCommand, type LinearCommand } from "../core";
import { journalCaught } from "../journal";
import { INSTANCE_DEAD_MS } from "./instances";
import { claimNextJob, completeJob, enqueueJobOnce } from "./jobs";
import { orm } from "./orm";
import { instance, run, runOwner } from "./schema";

export function commandDeliveryQueue(instanceId: string): string {
  return `${JOB_KIND.command}.deliver:${instanceId}`;
}

export const COMMAND_DELIVERY_MS = 1_000;

export function forwardCommand(
  db: Database,
  command: LinearCommand,
  self: string,
  now = Date.now(),
): string[] {
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
      payload: { command },
      now,
      runAt: now,
    });
  return owners;
}

export function drainInstanceCommands(
  db: Database,
  self: string,
  deliver: (command: LinearCommand) => void,
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
    const command = parseLinearCommand((job.payload as { command?: unknown } | null)?.command);
    if (!completeJob(db, job, now) || command === null) continue;
    try {
      deliver(command);
    } catch (error) {
      journalCaught(error, "commandDelivery.drainInstanceCommands.deliver", command.itemId);
    }
    delivered += 1;
  }
}
