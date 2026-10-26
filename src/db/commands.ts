import type { Database } from "bun:sqlite";
import {
  CommandBus,
  JOB_KIND,
  OUTBOX_ACTIVITY,
  parseLinearCommand,
  transition,
  type LinearCommand,
} from "../core";
import { applyWorkItemEvent, getWorkItem } from "./items";
import {
  claimNextJob,
  completeJob,
  enqueueJob,
  enqueueJobOnce,
  errorText,
  noteJobError,
} from "./jobs";
import { enqueueOutboxOnce, stopOutboxSession, advanceOutboxSession } from "./outbox";
import { markRun } from "./runs";
import { halt } from "./halt";
import { enqueueEndedSessionFace, stoppedResponse } from "./stop-response";
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
  /** Replaces the default "Stopped." or "Cancelled from Linear." lead of the response. */
  response?: string,
): { applied: boolean } {
  return immediate(db, () => {
    const item = getWorkItem(db, command.itemId);
    if (item === null) return { applied: false };
    if (!transition(item.state, "cancel").ok) return { applied: false };
    try {
      immediate(db, () => {
        if (!halt(db, item, now)) throw new Error("Stop owner changed");
        applyWorkItemEvent(db, item.id, "cancel");
      });
    } catch {
      return { applied: false };
    }
    db.run("UPDATE work_item SET cancel_requested = 1 WHERE id = ?", [item.id]);
    db.run(
      "UPDATE question SET cancelled_at = ? WHERE item_id = ? AND status IN ('open', 'queued') AND cancelled_at IS NULL",
      [now, item.id],
    );
    if (item.currentRunId !== null) markRun(db, item.currentRunId, "lost", now);
    const closing =
      item.state === "merge_queue" ||
      db
        .query(
          "SELECT 1 FROM job WHERE (queue=? OR queue LIKE ?) AND json_extract(payload,'$.itemId')=? LIMIT 1",
        )
        .get(JOB_KIND.merge, `${JOB_KIND.merge}.%`, item.id) !== null;
    if (closing)
      enqueueJobOnce(db, {
        queue: JOB_KIND.closeStoppedPull,
        jobKey: `close-stopped:${item.id}:${getWorkItem(db, item.id)!.version}`,
        payload: { itemId: item.id },
        now,
      });

    const sessionId = item.sessionKey ?? item.id;
    const closed = response?.startsWith("Closed:") === true;
    const generation = !closed
      ? stopOutboxSession(db, OUTBOX_ACTIVITY.target, sessionId, now)
      : advanceOutboxSession(db, OUTBOX_ACTIVITY.target, sessionId, { now });
    const origin = command.source === "dashboard" ? "Paws" : "Linear";
    const lead =
      response ??
      (command.type === "cancel"
        ? `Cancelled from ${origin}.`
        : command.source === "dashboard"
          ? "Stopped from Paws."
          : "Stopped.");
    const text = stoppedResponse(db, item, lead, {
      reason: response !== undefined,
      pullClosing: closing,
    });
    enqueueOutboxOnce(db, {
      target: OUTBOX_ACTIVITY.target,
      op: OUTBOX_ACTIVITY.op,
      orderingKey: sessionId,
      delivery: closed ? "ordered" : "stop",
      generation,
      idempotencyKey: !closed
        ? `command:stop:${sessionId}:${generation}`
        : `closed:${item.id}:${generation}`,
      payload: { sessionId, kind: "response", body: text, id: crypto.randomUUID() },
      now,
    });
    enqueueEndedSessionFace(db, { sessionId, generation, item, outcome: "stopped", now });
    return { applied: true };
  });
}

/**
 * A person takes the item over: Paws halts it, applies `take_over` and ends the session with
 * one response. Nothing restarts, verifies or merges the item afterwards.
 */
export function takeOverItem(
  db: Database,
  itemId: string,
  who: string,
  now = Date.now(),
): { applied: boolean } {
  return immediate(db, () => {
    const item = getWorkItem(db, itemId);
    if (item === null || !transition(item.state, "take_over").ok) return { applied: false };
    applyWorkItemEvent(db, item.id, "take_over", { now, actor: who });
    const sessionId = item.sessionKey ?? item.id;
    const generation = stopOutboxSession(db, OUTBOX_ACTIVITY.target, sessionId, now);
    enqueueOutboxOnce(db, {
      target: OUTBOX_ACTIVITY.target,
      op: OUTBOX_ACTIVITY.op,
      orderingKey: sessionId,
      delivery: "stop",
      generation,
      idempotencyKey: `command:take-over:${sessionId}:${generation}`,
      payload: {
        sessionId,
        kind: "response",
        body: `Taken over by ${who}. Paws will not restart, verify or merge ${item.linearIdentifier}.`,
        id: crypto.randomUUID(),
      },
      now,
    });
    enqueueEndedSessionFace(db, { sessionId, generation, item, outcome: "manual", now });
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
