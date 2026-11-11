import { journalCaught } from "../journal";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Database } from "bun:sqlite";
import {
  enqueueOutboxOnceSteps,
  getLinearSessionGenerationSteps,
  getWorkItemSteps,
  lastRunnerEventSequenceSteps,
  openRunnerWorkCommandSteps,
  pullRequestReadyQueuedSteps,
  runnerEventsAfterSteps,
  runnerHandoverSentSteps,
  runnerResultPayloadSteps,
  saveCheckpointSteps,
  sqliteDb,
  type Db,
} from "../db";
import { OUTBOX_ACTIVITY } from "../core";
import {
  CHECKPOINT_RUNNER_VERSION,
  RUNNER_CHECKPOINT_LIMIT_MS,
  type RunnerCommand,
  type RunnerEvent,
} from "../runner-protocol";
import { RUNNER_ONLINE_MS } from "../runner-placement";
import type { RunnerWork } from "../runner-work";
import { versionAtLeast } from "./session-restore";

/** Past the runner's limit: polling and delivery of its checkpoint. */
const DELIVERY_GRACE_MS = 30_000;

/** Item states in which a stop ended the work, so the saved commit is worth a line in Linear. */
const STOPPED = new Set(["failed", "paused", "awaiting_input", "cancelled", "manual"]);

/**
 * A runner's published WIP commit becomes the item's checkpoint, so the next turn starts from it.
 * A stop that saved one says so once in the item's session.
 */
export async function recordRunnerCheckpoint(
  store: Db,
  input: {
    itemId: string;
    runId: string;
    baseSha: string;
    mainSha?: string;
    event: Extract<RunnerEvent, { type: "checkpoint" }>;
    now: number;
  },
): Promise<void> {
  const { event } = input;
  if (!event.sha || event.dropped !== undefined) return;
  const sha = event.sha;
  await store.transaction(function* (q) {
    const item = yield* getWorkItemSteps(q, input.itemId);
    if (!item || item.currentRunId !== input.runId) return;
    const { checkpointMain: _, ...checkpoint } = item.checkpoint ?? {
      phase: "running" as const,
      baseSha: input.baseSha,
    };
    yield* saveCheckpointSteps(q, item.id, {
      ...checkpoint,
      wipCommit: sha,
      ...(input.mainSha ? { checkpointMain: { sha, main: input.mainSha } } : {}),
    });
    if (event.reason !== "stop" || !STOPPED.has(item.state)) return;
    const sessionId = item.sessionKey ?? item.id;
    // After the pull request response, only the final line goes to the session.
    const generation = yield* getLinearSessionGenerationSteps(q, sessionId);
    if (yield* pullRequestReadyQueuedSteps(q, sessionId, generation)) return;
    yield* enqueueOutboxOnceSteps(q, {
      target: OUTBOX_ACTIVITY.target,
      op: OUTBOX_ACTIVITY.op,
      orderingKey: sessionId,
      idempotencyKey: `checkpoint-saved:${input.runId}:${sha}`,
      payload: {
        sessionId,
        kind: "thought",
        body: `Saved the work so far at ${sha.slice(0, 7)} before stopping.`,
      },
      now: input.now,
    });
  });
}

/**
 * Asks the runner of a running run to publish its worktree as a WIP commit before Paws stops it,
 * and waits for the commit to arrive. Returns the commit, or null when there was nothing new,
 * the runner cannot checkpoint, or it did not answer in time. The stop goes ahead either way.
 */
export function createRemoteCheckpoint(options: {
  db: Database;
  store?: Db;
  work: RunnerWork;
  now?: () => number;
  pollIntervalMs?: number;
}) {
  const { db, work } = options;
  const store = options.store ?? sqliteDb(db);
  const now = options.now ?? Date.now;
  const pending = new Map<string, Promise<string | null>>();
  /** Sends the checkpoint command, or returns null when the run cannot answer one. */
  function ask(runId: string) {
    return store.transaction(function* (q) {
      const row = yield* openRunnerWorkCommandSteps(q, runId);
      if (!row) return null;
      const command = JSON.parse(
        Buffer.from(
          (JSON.parse(row.envelope) as { payload: string }).payload,
          "base64url",
        ).toString("utf8"),
      ) as RunnerCommand;
      if (command.type !== "run" || command.checkpoint === false) return null;
      // A handover publishes its own WIP commit; a stop of the same run keeps that checkpoint.
      if (yield* runnerHandoverSentSteps(q, runId, row.generation)) return null;
      // A runner that is gone or too old never answers; the stop does not wait for it.
      if ((row.lastSeen ?? 0) <= now() - RUNNER_ONLINE_MS) return null;
      if (!versionAtLeast(row.version, CHECKPOINT_RUNNER_VERSION)) return null;
      const at = now();
      yield* work.enqueueSteps(q, {
        id: randomUUID(),
        type: "checkpoint",
        runId,
        runnerId: row.runnerId,
        workspaceId: row.workspaceId,
        generation: row.generation,
        issuedAt: at,
        expiresAt: at + RUNNER_CHECKPOINT_LIMIT_MS,
      });
      const after = yield* lastRunnerEventSequenceSteps(q, runId, row.generation);
      return {
        command,
        after,
        deadline: at + RUNNER_CHECKPOINT_LIMIT_MS + DELIVERY_GRACE_MS,
      };
    });
  }
  async function wait(
    runId: string,
    request: NonNullable<Awaited<ReturnType<typeof ask>>>,
  ): Promise<string | null> {
    const { command } = request;
    let cursor = request.after;
    while (now() < request.deadline) {
      const after = cursor;
      const rows = await store.run((q) =>
        runnerEventsAfterSteps(q, {
          runId,
          generation: command.generation,
          after,
          types: ["checkpoint"],
        }),
      );
      for (const row of rows) {
        cursor = row.sequence;
        const event = await work.openEvent(row);
        if (event.type !== "checkpoint") continue;
        await recordRunnerCheckpoint(store, {
          itemId: command.itemId,
          runId,
          baseSha: command.repository.baseSha,
          ...(command.repository.mainSha ? { mainSha: command.repository.mainSha } : {}),
          event,
          now: now(),
        });
        if (event.reason === "stop")
          return event.sha && event.dropped === undefined ? event.sha : null;
      }
      // The turn ended first: its own result carries the work.
      if ((await store.run((q) => runnerResultPayloadSteps(q, runId, command.generation))) !== null)
        return null;
      await delay(options.pollIntervalMs ?? 250);
    }
    return null;
  }
  /** Null as soon as nothing was asked of the runner; the stop need not wait then. */
  return function checkpointBeforeStop(runId: string): Promise<string | null> {
    const running = pending.get(runId);
    if (running) return running;
    const waiting = (async () => {
      let request: Awaited<ReturnType<typeof ask>>;
      try {
        request = await ask(runId);
      } catch (error) {
        journalCaught(error, "runner-backend.checkpointBeforeStop", null);
        return null;
      }
      if (!request) return null;
      return wait(runId, request).catch((error: unknown) => {
        journalCaught(error, "runner-backend.checkpointBeforeStop", null);
        return null;
      });
    })().finally(() => pending.delete(runId));
    pending.set(runId, waiting);
    return waiting;
  };
}
