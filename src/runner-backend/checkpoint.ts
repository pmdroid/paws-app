import { journalCaught } from "../journal";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Database } from "bun:sqlite";
import {
  enqueueOutboxOnce,
  getLinearSessionGeneration,
  getWorkItem,
  immediate,
  saveCheckpoint,
} from "../db";
import { OUTBOX_ACTIVITY } from "../core";
import {
  CHECKPOINT_RUNNER_VERSION,
  RUNNER_CHECKPOINT_LIMIT_MS,
  RunnerEventSchema,
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
export function recordRunnerCheckpoint(
  db: Database,
  input: {
    itemId: string;
    runId: string;
    baseSha: string;
    event: Extract<RunnerEvent, { type: "checkpoint" }>;
    now: number;
  },
): void {
  const { event } = input;
  if (!event.sha || event.dropped !== undefined) return;
  const sha = event.sha;
  immediate(db, () => {
    const item = getWorkItem(db, input.itemId);
    if (!item || item.currentRunId !== input.runId) return;
    saveCheckpoint(db, item.id, {
      ...(item.checkpoint ?? { phase: "running", baseSha: input.baseSha }),
      wipCommit: sha,
    });
    if (event.reason !== "stop" || !STOPPED.has(item.state)) return;
    const sessionId = item.sessionKey ?? item.id;
    // After the pull request response, only the final line goes to the session.
    const afterPr =
      db
        .query(`SELECT 1 FROM outbox WHERE target='linear' AND ordering_key=?
        AND delivery_generation=? AND idempotency_key LIKE 'pull-request-ready:%' AND status!='dropped' LIMIT 1`)
        .get(sessionId, getLinearSessionGeneration(db, sessionId)) !== null;
    if (afterPr) return;
    enqueueOutboxOnce(db, {
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
  work: RunnerWork;
  now?: () => number;
  pollIntervalMs?: number;
}) {
  const { db, work } = options;
  const now = options.now ?? Date.now;
  const pending = new Map<string, Promise<string | null>>();
  /** Sends the checkpoint command, or returns null when the run cannot answer one. */
  function ask(runId: string) {
    return immediate(db, () => {
      const row = db
        .query<
          {
            runnerId: string;
            workspaceId: string;
            generation: number;
            envelope: string;
            lastSeen: number | null;
            version: string | null;
          },
          [string]
        >(
          `SELECT w.runner_id AS runnerId,w.workspace_id AS workspaceId,w.generation,c.envelope,
           r.last_seen_at AS lastSeen,h.runner_version AS version
           FROM runner_work w JOIN runner_command c ON c.id=w.command_id
           JOIN runner r ON r.id=w.runner_id
           LEFT JOIN runner_host_status h ON h.runner_id=w.runner_id
           WHERE w.run_id=? AND w.ended_at IS NULL`,
        )
        .get(runId);
      if (!row) return null;
      const command = JSON.parse(
        Buffer.from(
          (JSON.parse(row.envelope) as { payload: string }).payload,
          "base64url",
        ).toString("utf8"),
      ) as RunnerCommand;
      if (command.type !== "run" || command.checkpoint === false) return null;
      // A handover publishes its own WIP commit; a stop of the same run keeps that checkpoint.
      if (
        db
          .query("SELECT 1 FROM runner_command WHERE run_id=? AND generation=? AND kind='handover'")
          .get(runId, row.generation)
      )
        return null;
      // A runner that is gone or too old never answers; the stop does not wait for it.
      if ((row.lastSeen ?? 0) <= now() - RUNNER_ONLINE_MS) return null;
      if (!versionAtLeast(row.version, CHECKPOINT_RUNNER_VERSION)) return null;
      const at = now();
      work.enqueue({
        id: randomUUID(),
        type: "checkpoint",
        runId,
        runnerId: row.runnerId,
        workspaceId: row.workspaceId,
        generation: row.generation,
        issuedAt: at,
        expiresAt: at + RUNNER_CHECKPOINT_LIMIT_MS,
      });
      const after = db
        .query<{ sequence: number }, [string, number]>(
          "SELECT COALESCE(MAX(sequence),0) AS sequence FROM runner_event WHERE run_id=? AND generation=?",
        )
        .get(runId, row.generation)!.sequence;
      return {
        command,
        after,
        deadline: at + RUNNER_CHECKPOINT_LIMIT_MS + DELIVERY_GRACE_MS,
      };
    });
  }
  async function wait(
    runId: string,
    request: NonNullable<ReturnType<typeof ask>>,
  ): Promise<string | null> {
    const { command } = request;
    let cursor = request.after;
    while (now() < request.deadline) {
      const rows = db
        .query<{ sequence: number; payload: string }, [string, number, number]>(
          `SELECT sequence,payload FROM runner_event WHERE run_id=? AND generation=? AND sequence>?
           AND json_extract(payload,'$.type')='checkpoint' ORDER BY sequence`,
        )
        .all(runId, command.generation, cursor);
      for (const row of rows) {
        cursor = row.sequence;
        const event = RunnerEventSchema.parse(JSON.parse(row.payload));
        if (event.type !== "checkpoint") continue;
        recordRunnerCheckpoint(db, {
          itemId: command.itemId,
          runId,
          baseSha: command.repository.baseSha,
          event,
          now: now(),
        });
        if (event.reason === "stop")
          return event.sha && event.dropped === undefined ? event.sha : null;
      }
      // The turn ended first: its own result carries the work.
      if (
        db
          .query("SELECT 1 FROM runner_result WHERE run_id=? AND generation=?")
          .get(runId, command.generation)
      )
        return null;
      await delay(options.pollIntervalMs ?? 250);
    }
    return null;
  }
  /** Null, at once, when nothing was asked of the runner; the stop need not wait then. */
  return function checkpointBeforeStop(runId: string): Promise<string | null> | null {
    const running = pending.get(runId);
    if (running) return running;
    let request: ReturnType<typeof ask>;
    try {
      request = ask(runId);
    } catch (error) {
      journalCaught(error, "runner-backend.checkpointBeforeStop", null);
      return null;
    }
    if (!request) return null;
    const waiting = wait(runId, request)
      .catch((error: unknown) => {
        journalCaught(error, "runner-backend.checkpointBeforeStop", null);
        return null;
      })
      .finally(() => pending.delete(runId));
    pending.set(runId, waiting);
    return waiting;
  };
}
