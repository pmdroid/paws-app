import type { Database } from "bun:sqlite";
import {
  CommandBus,
  JOB_KIND,
  OUTBOX_ACTIVITY,
  parseLinearCommand,
  type LinearCommand,
} from "../core";
import { applyWorkItemEvent, getWorkItem } from "./items";
import {
  cancelOpenJobs,
  claimNextJob,
  completeJob,
  enqueueJob,
  enqueueJobOnce,
  errorText,
  noteJobError,
} from "./jobs";
import { enqueueOutboxOnce, stopOutboxSession } from "./outbox";
import { markRun } from "./runs";
import { immediate } from "./tx";

export function enqueueCommand(
  db: Database,
  command: LinearCommand,
  now = command.requestedAt,
): number {
  return enqueueJob(db, {
    queue: JOB_KIND.command,
    jobKey: `cmd:${command.type}:${command.itemId}:${command.requestedAt}`,
    priority: 0,
    payload: command,
    now,
    runAt: now,
  });
}

export function applyLinearCommand(
  db: Database,
  command: LinearCommand,
  now = command.requestedAt,
): { applied: boolean } {
  return immediate(db, () => {
    const item = getWorkItem(db, command.itemId);
    if (item === null) return { applied: false };
    try {
      applyWorkItemEvent(db, item.id, "cancel");
    } catch {
      return { applied: false };
    }
    db.run("UPDATE work_item SET cancel_requested = 1 WHERE id = ?", [item.id]);
    db.run(
      "UPDATE linear_github_auth SET status = 'revoked',generation = generation + 1 WHERE item_id = ? AND status IN ('pending','expired')",
      [item.id],
    );
    db.run(
      "UPDATE question SET cancelled_at = ? WHERE item_id = ? AND status = 'open' AND cancelled_at IS NULL",
      [now, item.id],
    );
    if (item.currentRunId !== null) markRun(db, item.currentRunId, "lost", now);
    cancelOpenJobs(db, { itemId: item.id, reason: command.type, now });
    if (
      item.state === "merge_queue" ||
      db
        .query(
          "SELECT 1 FROM job WHERE (queue=? OR queue LIKE ?) AND json_extract(payload,'$.itemId')=? LIMIT 1",
        )
        .get(JOB_KIND.merge, `${JOB_KIND.merge}.%`, item.id)
    )
      enqueueJobOnce(db, {
        queue: JOB_KIND.closeStoppedPull,
        jobKey: `close-stopped:${item.id}:${getWorkItem(db, item.id)!.version}`,
        payload: { itemId: item.id },
        now,
      });

    const sessionId = item.sessionKey ?? item.id;
    const generation = stopOutboxSession(db, OUTBOX_ACTIVITY.target, sessionId, now);
    const origin = command.source === "dashboard" ? "Paws" : "Linear";
    const text = command.type === "stop" ? `Stopped from ${origin}.` : `Cancelled from ${origin}.`;
    enqueueOutboxOnce(db, {
      target: OUTBOX_ACTIVITY.target,
      op: OUTBOX_ACTIVITY.op,
      orderingKey: sessionId,
      delivery: "stop",
      generation,
      idempotencyKey: `command:stop:${sessionId}:${generation}`,
      payload: { sessionId, kind: "response", body: text, id: crypto.randomUUID() },
      now,
    });
    return { applied: true };
  });
}

export function drainCommands(db: Database, bus: CommandBus, now = Date.now()): number {
  let handled = 0;
  for (;;) {
    const job = claimNextJob(db, { workerId: "command-drain", now, queues: [JOB_KIND.command] });
    if (job === null) break;
    const command = parseLinearCommand(job.payload);
    const applied = command !== null && applyLinearCommand(db, command, now).applied;
    const completed = completeJob(db, job, now);
    if (applied && completed && command !== null) {
      try {
        bus.emit(command);
      } catch (error) {
        noteJobError(db, job.id, errorText(error));
      }
    }
    handled += 1;
  }
  return handled;
}

/** Enqueue the command and apply it before returning, ahead of the main loop. */
export function submitCommand(
  db: Database,
  bus: CommandBus,
  command: LinearCommand,
): { applied: boolean } {
  const before = getWorkItem(db, command.itemId)?.state;
  enqueueCommand(db, command);
  drainCommands(db, bus, command.requestedAt);
  const after = getWorkItem(db, command.itemId);
  return { applied: before !== "cancelled" && after?.state === "cancelled" };
}
