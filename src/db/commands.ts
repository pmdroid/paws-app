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
import { commandInstance, forwardCommandSteps } from "./command-delivery";
import { applyWorkItemEventSteps, getWorkItemSteps, type WorkItemRecord } from "./items";
import {
  claimNextJobSteps,
  completeJobSteps,
  parkLeasedJobSteps,
  emitJobReady,
  enqueueJobOnceSteps,
  errorText,
  noteJobErrorSteps,
} from "./jobs";
import {
  enqueueOutboxOnceSteps,
  stopOutboxSessionSteps,
  advanceOutboxSessionSteps,
} from "./outbox";
import { withOpenFindingsSteps } from "./open-findings";
import { markRunSteps } from "./runs";
import { haltSteps } from "./halt";
import { enqueueEndedSessionFaceSteps, stoppedResponseSteps } from "./stop-response";
import { mergeCallInFlightSteps, getConfirmedRemoteMergeSteps } from "./remote-merges";
import { settled, sqliteDb, type Q, type Db, type Steps } from "./db";

export function* enqueueCommandSteps(q: Q, command: LinearCommand, now = command.requestedAt) {
  return yield* enqueueJobOnceSteps(q, {
    queue: JOB_KIND.command,
    jobKey: `cmd:${command.type}:${command.itemId}:${command.requestedAt}`,
    priority: 0,
    payload: command,
    now,
    runAt: now,
  });
}

export function enqueueCommand(
  db: Database,
  command: LinearCommand,
  now = command.requestedAt,
): number {
  const { id, inserted } = settled(sqliteDb(db).run((q) => enqueueCommandSteps(q, command, now)));
  if (inserted) emitJobReady(db);
  return id;
}

export async function applyLinearCommand(
  store: Db,
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
): Promise<{ applied: boolean; deferred?: boolean }> {
  return applyLinearCommandAsync(store, command, now, response, options, commandInstance(store));
}

export function* applyLinearCommandSteps(
  q: Q,
  command: LinearCommand,
  now = command.requestedAt,
  response?: string,
  options: CommandOptions = {},
  self?: string,
  notifications = { ready: false },
): Steps<{ applied: boolean; deferred?: boolean }> {
  const result = yield* applyCommandRowsSteps(q, command, now, response, options, notifications);
  if (result.applied && self !== undefined) {
    const forwarded = yield* forwardCommandSteps(q, self, command, now);
    notifications.ready ||= forwarded.inserted;
  }
  return result;
}
export async function applyLinearCommandAsync(
  store: Db,
  command: LinearCommand,
  now = command.requestedAt,
  response?: string,
  options: CommandOptions = {},
  self?: string,
) {
  const notifications = { ready: false };
  const result = await store.transaction((q) =>
    applyLinearCommandSteps(q, command, now, response, options, self, notifications),
  );
  if (notifications.ready) emitJobReady(store);
  return result;
}

export function* applyCommandRowsSteps(
  q: Q,
  command: LinearCommand,
  now: number,
  response: string | undefined,
  options: CommandOptions,
  notifications = { ready: false },
): Steps<{ applied: boolean; deferred?: boolean }> {
  return yield* q.transaction(function* (tx0) {
    const { workItem, question, job: jobTable } = tx0.t;
    const item = yield* getWorkItemSteps(tx0, command.itemId);
    if (item === null) return { applied: false };
    if (yield* mergeCallInFlightSteps(tx0, item.id)) {
      // The command row is the durable request. Do not fence the lane before it records GitHub's fact.
      const enqueued = yield* enqueueJobOnceSteps(tx0, {
        queue: JOB_KIND.command,
        jobKey: `cmd:${command.type}:${command.itemId}:${command.requestedAt}`,
        payload: { ...command, response, options },
        now,
        runAt: now + 1_000,
      });
      notifications.ready ||= enqueued.inserted;
      return { applied: false, deferred: true };
    }
    if (item.state === "merged") {
      const fact = yield* getConfirmedRemoteMergeSteps(tx0, item.id);
      if (fact)
        yield* enqueueOutboxOnceSteps(tx0, {
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
      return yield* pauseFromLinearSteps(tx0, item, now);
    if (!transition(item.state, "cancel").ok) return { applied: false };
    try {
      yield* tx0.transaction(function* (tx1) {
        if (!(yield* haltSteps(tx1, item, now))) throw new Error("Stop owner changed");
        yield* applyWorkItemEventSteps(tx1, item.id, "cancel", { now });
      });
    } catch (caughtError1) {
      journalCaught(caughtError1, "commands.applyLinearCommand.applyWorkItemEvent", command.itemId);
      return { applied: false };
    }
    yield* tx0.exec(
      tx0.orm.update(workItem).set({ cancelRequested: 1 }).where(eq(workItem.id, item.id)),
    );
    yield* tx0.exec(
      tx0.orm
        .update(question)
        .set({ cancelledAt: now })
        .where(
          and(
            eq(question.itemId, item.id),
            inArray(question.status, ["open", "queued"]),
            isNull(question.cancelledAt),
          ),
        ),
    );
    if (item.currentRunId !== null) yield* markRunSteps(tx0, item.currentRunId, "lost", now);
    const keepPullRequest =
      options.keepPullRequest ?? (command.type === "stop" && command.source === "linear");
    const closing =
      options.closePullRequest !== undefined ||
      (!keepPullRequest &&
        (item.state === "merge_queue" ||
          (yield* tx0.one(
            tx0.orm
              .select({ one: sql`1` })
              .from(jobTable)
              .where(
                and(
                  or(
                    eq(jobTable.queue, JOB_KIND.merge),
                    like(jobTable.queue, `${JOB_KIND.merge}.%`),
                  ),
                  tx0.dialect === "sqlite"
                    ? sql`json_extract(${jobTable.payload}, '$.itemId') = ${item.id}`
                    : sql`${jobTable.payload}->>'itemId' = ${item.id}`,
                ),
              ),
          )) !== undefined));
    if (closing) {
      const enqueued = yield* enqueueJobOnceSteps(tx0, {
        queue: JOB_KIND.closeStoppedPull,
        jobKey: `close-stopped:${item.id}:${(yield* getWorkItemSteps(tx0, item.id))!.version}`,
        payload: {
          itemId: item.id,
          ...(options.closePullRequest ? { comment: options.closePullRequest.comment } : {}),
        },
        now,
      });

      notifications.ready ||= enqueued.inserted;
    }
    const sessionId = item.sessionKey ?? item.id;
    const closed =
      response?.startsWith("Closed:") === true || options.closePullRequest !== undefined;
    const generation = !closed
      ? yield* stopOutboxSessionSteps(tx0, OUTBOX_ACTIVITY.target, sessionId, now)
      : yield* advanceOutboxSessionSteps(tx0, OUTBOX_ACTIVITY.target, sessionId, { now });
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
        : yield* withOpenFindingsSteps(
            tx0,
            item.id,
            yield* stoppedResponseSteps(tx0, item, lead, {
              reason: response !== undefined,
              pullClosing: closing,
            }),
          );
    yield* enqueueOutboxOnceSteps(tx0, {
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
    yield* enqueueEndedSessionFaceSteps(tx0, {
      sessionId,
      generation,
      item,
      outcome: "stopped",
      now,
    });
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

export function* pauseFromLinearSteps(
  q: Q,
  item: WorkItemRecord,
  now: number,
): Steps<{ applied: boolean }> {
  if (item.state !== "paused") {
    try {
      yield* q.transaction(function* (tx2) {
        if (!(yield* haltSteps(tx2, item, now))) throw new Error("Stop owner changed");
        yield* applyWorkItemEventSteps(tx2, item.id, "pause", { now });
      });
    } catch (caughtError) {
      journalCaught(caughtError, "commands.pauseFromLinear.applyWorkItemEvent", item.id);
      return { applied: false };
    }
  }
  const sessionId = item.sessionKey ?? item.id;
  const generation = yield* stopOutboxSessionSteps(q, OUTBOX_ACTIVITY.target, sessionId, now);
  yield* enqueueOutboxOnceSteps(q, {
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
export function* takeOverItemSteps(
  q: Q,
  itemId: string,
  who: string,
  now = Date.now(),
): Steps<{ applied: boolean }> {
  return yield* q.transaction(function* (tx3) {
    const item = yield* getWorkItemSteps(tx3, itemId);
    if (item === null || !transition(item.state, "take_over").ok) return { applied: false };
    yield* applyWorkItemEventSteps(tx3, item.id, "take_over", { now, actor: who });
    const sessionId = item.sessionKey ?? item.id;
    const generation = yield* stopOutboxSessionSteps(tx3, OUTBOX_ACTIVITY.target, sessionId, now);
    yield* enqueueOutboxOnceSteps(tx3, {
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
    yield* enqueueEndedSessionFaceSteps(tx3, {
      sessionId,
      generation,
      item,
      outcome: "manual",
      now,
    });
    return { applied: true };
  });
}

export function* drainCommandsSteps(
  q: Q,
  delivered: (command: LinearCommand) => void,
  now = Date.now(),
  self?: string,
  ready: () => void = () => {},
): Steps<number> {
  let handled = 0;
  for (;;) {
    const job = yield* claimNextJobSteps(q, {
      workerId: "command-drain",
      now,
      queues: [JOB_KIND.command],
    });
    if (job === null) break;
    const command = parseLinearCommand(job.payload);
    const saved = job.payload as {
      response?: string;
      options?: CommandOptions;
    };
    const notifications = { ready: false };
    const result =
      command !== null
        ? yield* q.transaction((tx) =>
            applyLinearCommandSteps(
              tx,
              command,
              now,
              saved.response,
              saved.options,
              self,
              notifications,
            ),
          )
        : null;
    if (notifications.ready) ready();
    if (result?.deferred) {
      yield* parkLeasedJobSteps(q, job, {
        runAt: now + 1_000,
        payload: job.payload,
        attempts: 0,
        now,
      });
      handled += 1;
      continue;
    }
    const applied = result?.applied === true;
    const completed = yield* completeJobSteps(q, job, now);
    if (applied && completed && command !== null) {
      try {
        delivered(command);
      } catch (error) {
        journalCaught(error, "commands.drainCommands.emit", command.itemId);
        yield* noteJobErrorSteps(q, job.id, errorText(error));
      }
    }
    handled += 1;
  }
  return handled;
}

export async function drainCommands(
  store: Db,
  bus: CommandBus,
  now = Date.now(),
  self = commandInstance(store),
): Promise<number> {
  return await store.run((q) =>
    drainCommandsSteps(
      q,
      (command) => bus.emit(command),
      now,
      self,
      () => emitJobReady(store),
    ),
  );
}

export function* submitCommandSteps(
  q: Q,
  command: LinearCommand,
  delivered: (command: LinearCommand) => void,
  ready: () => void,
  self?: string,
): Steps<{ applied: boolean }> {
  const before = (yield* getWorkItemSteps(q, command.itemId))?.state;
  const enqueued = yield* enqueueCommandSteps(q, command);
  if (enqueued.inserted) ready();
  yield* drainCommandsSteps(q, delivered, command.requestedAt, self, ready);
  const after = yield* getWorkItemSteps(q, command.itemId);
  return {
    applied:
      (before !== "cancelled" && after?.state === "cancelled") ||
      (before !== "paused" && after?.state === "paused"),
  };
}
/** Enqueue the command and apply it before returning, ahead of the main loop. */
export async function submitCommand(
  store: Db,
  bus: CommandBus,
  command: LinearCommand,
  self = commandInstance(store),
): Promise<{ applied: boolean }> {
  return await store.run((q) =>
    submitCommandSteps(
      q,
      command,
      (c) => bus.emit(c),
      () => emitJobReady(store),
      self,
    ),
  );
}

export async function takeOverItem(
  store: Db,
  itemId: string,
  who: string,
  now = Date.now(),
): Promise<{ applied: boolean }> {
  return await store.transaction((q) => takeOverItemSteps(q, itemId, who, now));
}
