import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { and, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import {
  CommandBus,
  JOB_KIND,
  OUTBOX_ACTIVITY,
  parseLinearCommand,
  transition,
  type LinearCommand,
} from "../core";
import { forwardCommand } from "./command-delivery";
import { applyWorkItemEvent, getWorkItem, type WorkItemRecord } from "./items";
import {
  claimNextJob,
  completeJob,
  parkLeasedJob,
  enqueueJobOnce,
  errorText,
  noteJobError,
} from "./jobs";
import { enqueueOutboxOnce, stopOutboxSession, advanceOutboxSession } from "./outbox";
import { withOpenFindings } from "./open-findings";
import { markRun } from "./runs";
import { halt } from "./halt";
import { enqueueEndedSessionFace, stoppedResponse } from "./stop-response";
import { mergeCallInFlight, getConfirmedRemoteMerge } from "./remote-merges";
import { orm } from "./orm";
import { job as jobTable, question, workItem } from "./schema";
import { immediate } from "./tx";

export function enqueueCommand(
  db: Database,
  command: LinearCommand,
  now = command.requestedAt,
): number {
  return enqueueJobOnce(db, {
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
  /**
   * `keepPullRequest`: the stop leaves the item's pull request open, as Stop on the Risk card does.
   * A stop from Linear (stop button, `/paws stop`, an archived session) keeps it unless the caller
   * passes `false`, as a fresh re-delegation does.
   * `closePullRequest`: the cancel closes the item's open pull request whatever its state, and the
   * close job first posts `comment` on it, as an issue canceled in Linear does.
   */
  options: CommandOptions = {},
): { applied: boolean; deferred?: boolean } {
  return immediate(db, () => {
    const result = applyCommandRows(db, command, now, response, options);
    if (result.applied) forwardCommand(db, command, now);
    return result;
  });
}

function applyCommandRows(
  db: Database,
  command: LinearCommand,
  now: number,
  response: string | undefined,
  options: CommandOptions,
): { applied: boolean; deferred?: boolean } {
  return immediate(db, () => {
    const item = getWorkItem(db, command.itemId);
    if (item === null) return { applied: false };
    if (mergeCallInFlight(db, item.id)) {
      // The command row is the durable request. Do not fence the lane before it records GitHub's fact.
      enqueueJobOnce(db, {
        queue: JOB_KIND.command,
        jobKey: `cmd:${command.type}:${command.itemId}:${command.requestedAt}`,
        payload: { ...command, response, options },
        now,
        runAt: now + 1_000,
      });
      return { applied: false, deferred: true };
    }
    if (item.state === "merged") {
      const fact = getConfirmedRemoteMerge(db, item.id);
      if (fact)
        enqueueOutboxOnce(db, {
          target: OUTBOX_ACTIVITY.target,
          op: OUTBOX_ACTIVITY.op,
          orderingKey: item.sessionKey ?? item.id,
          delivery: "stop",
          idempotencyKey: `command:already-merged:${item.id}:${command.requestedAt}`,
          payload: {
            sessionId: item.sessionKey ?? item.id,
            kind: "response",
            body: `Pull request #${fact.pullNumber} was already merged. ${item.linearIdentifier} is Done.`,
          },
          now,
        });
      return { applied: false };
    }
    if (
      command.type === "stop" &&
      command.source === "linear" &&
      response === undefined &&
      options.keepPullRequest !== false &&
      (item.state === "paused" || transition(item.state, "pause").ok)
    )
      return pauseFromLinear(db, item, now);
    if (!transition(item.state, "cancel").ok) return { applied: false };
    try {
      immediate(db, () => {
        if (!halt(db, item, now)) throw new Error("Stop owner changed");
        applyWorkItemEvent(db, item.id, "cancel", { now });
      });
    } catch (caughtError1) {
      journalCaught(caughtError1, "commands.applyLinearCommand.applyWorkItemEvent", command.itemId);
      return { applied: false };
    }
    orm(db).update(workItem).set({ cancelRequested: 1 }).where(eq(workItem.id, item.id)).run();
    orm(db)
      .update(question)
      .set({ cancelledAt: now })
      .where(
        and(
          eq(question.itemId, item.id),
          inArray(question.status, ["open", "queued"]),
          isNull(question.cancelledAt),
        ),
      )
      .run();
    if (item.currentRunId !== null) markRun(db, item.currentRunId, "lost", now);
    const keepPullRequest =
      options.keepPullRequest ?? (command.type === "stop" && command.source === "linear");
    const closing =
      options.closePullRequest !== undefined ||
      (!keepPullRequest &&
        (item.state === "merge_queue" ||
          orm(db)
            .select({ one: sql`1` })
            .from(jobTable)
            .where(
              and(
                or(eq(jobTable.queue, JOB_KIND.merge), like(jobTable.queue, `${JOB_KIND.merge}.%`)),
                sql`json_extract(${jobTable.payload}, '$.itemId') = ${item.id}`,
              ),
            )
            .get() !== undefined));
    if (closing)
      enqueueJobOnce(db, {
        queue: JOB_KIND.closeStoppedPull,
        jobKey: `close-stopped:${item.id}:${getWorkItem(db, item.id)!.version}`,
        payload: {
          itemId: item.id,
          ...(options.closePullRequest ? { comment: options.closePullRequest.comment } : {}),
        },
        now,
      });

    const sessionId = item.sessionKey ?? item.id;
    const closed =
      response?.startsWith("Closed:") === true || options.closePullRequest !== undefined;
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
    const text =
      options.responseOnly && response !== undefined
        ? response
        : withOpenFindings(
            db,
            item.id,
            stoppedResponse(db, item, lead, {
              reason: response !== undefined,
              pullClosing: closing,
            }),
          );
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
    // The issue's status stays with people and the GitHub integration.
    return { applied: true };
  });
}

type CommandOptions = {
  keepPullRequest?: boolean;
  responseOnly?: boolean;
  closePullRequest?: { comment: string };
};

const LINEAR_PAUSED_RESPONSE = "Paused. Reply here or re-delegate to continue.";

function pauseFromLinear(db: Database, item: WorkItemRecord, now: number): { applied: boolean } {
  if (item.state !== "paused") {
    try {
      immediate(db, () => {
        if (!halt(db, item, now)) throw new Error("Stop owner changed");
        applyWorkItemEvent(db, item.id, "pause", { now });
      });
    } catch (caughtError) {
      journalCaught(caughtError, "commands.pauseFromLinear.applyWorkItemEvent", item.id);
      return { applied: false };
    }
  }
  const sessionId = item.sessionKey ?? item.id;
  const generation = stopOutboxSession(db, OUTBOX_ACTIVITY.target, sessionId, now);
  enqueueOutboxOnce(db, {
    target: OUTBOX_ACTIVITY.target,
    op: OUTBOX_ACTIVITY.op,
    orderingKey: sessionId,
    delivery: "stop",
    generation,
    idempotencyKey: `command:stop:${sessionId}:${generation}`,
    payload: { sessionId, kind: "response", body: LINEAR_PAUSED_RESPONSE, id: crypto.randomUUID() },
    now,
  });
  return { applied: true };
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
    const saved = job.payload as {
      response?: string;
      options?: CommandOptions;
    };
    const result =
      command !== null ? applyLinearCommand(db, command, now, saved.response, saved.options) : null;
    if (result?.deferred) {
      parkLeasedJob(db, job, { runAt: now + 1_000, payload: job.payload, attempts: 0, now });
      handled += 1;
      continue;
    }
    const applied = result?.applied === true;
    const completed = completeJob(db, job, now);
    if (applied && completed && command !== null) {
      try {
        bus.emit(command);
      } catch (error) {
        journalCaught(error, "commands.drainCommands.emit", command.itemId);
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
  return {
    applied:
      (before !== "cancelled" && after?.state === "cancelled") ||
      (before !== "paused" && after?.state === "paused"),
  };
}
