import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Database } from "bun:sqlite";
import { getWorkItem, immediate } from "../db";
import {
  HANDOVER_RUNNER_VERSION,
  RUNNER_HANDOVER_LIMIT_MS,
  RunnerResultSchema,
  type RunnerHandoverFailure,
} from "../runner-protocol";
import type { RunnerWork } from "../runner-work";
import { versionAtLeast } from "./session-restore";

/** Past the runner's deadline: polling and delivery of its decision. */
const DELIVERY_GRACE_MS = 30_000;
/**
 * Once the runner stopped the agent, it makes the WIP commit and the session snapshot and
 * publishes them under their own timeouts; Paws waits this long for the outcome.
 */
const PUBLICATION_WAIT_MS = 30 * 60_000;

export type RunnerHandoverOutcome =
  /** The run ended with its WIP commit as the item's checkpoint, or nothing to commit. */
  | { status: "handed_over"; wipCommit: string | null }
  /** The run ended on its own before the runner stopped it. */
  | { status: "finished" }
  /** The runner found no safe point within 2 minutes: the session keeps running there. */
  | { status: "timed_out" }
  /**
   * The runner stopped the agent, then could not make the WIP commit, save the session or
   * publish them. The run stays on its runner, and its next turn loads the session there.
   */
  | { status: "failed"; reason: RunnerHandoverFailure }
  /**
   * The runner sent nothing within 2 minutes, published nothing after it stopped the agent, or
   * Paws could not keep the WIP commit.
   */
  | { status: "unanswered" }
  /** The runner's release cannot hand over; nothing was asked of it. */
  | { status: "old_runner" }
  | { status: "not_running" };

/**
 * Asks the runner of an item's running session to hand it over and waits for the outcome. The
 * running attempt in `forItem` imports the WIP commit as the checkpoint; this only waits for it.
 */
export function createRemoteHandover(options: {
  db: Database;
  work: RunnerWork;
  now?: () => number;
  pollIntervalMs?: number;
}) {
  const { db, work } = options;
  const now = options.now ?? Date.now;
  return async function handOverItem(
    itemId: string,
    signal?: AbortSignal,
  ): Promise<RunnerHandoverOutcome> {
    const request = immediate(db, () => {
      const row = db
        .query<
          { runId: string; runnerId: string; workspaceId: string; generation: number },
          [string]
        >(
          `SELECT w.run_id AS runId,w.runner_id AS runnerId,w.workspace_id AS workspaceId,
           w.generation FROM runner_work w JOIN run r ON r.id=w.run_id
           WHERE r.item_id=? AND w.ended_at IS NULL`,
        )
        .get(itemId);
      if (!row) return null;
      const version = db
        .query<{ version: string | null }, [string]>(
          "SELECT runner_version AS version FROM runner_host_status WHERE runner_id=?",
        )
        .get(row.runnerId)?.version;
      if (!versionAtLeast(version, HANDOVER_RUNNER_VERSION)) return "old_runner" as const;
      const at = now();
      work.enqueue({
        id: randomUUID(),
        type: "handover",
        runId: row.runId,
        runnerId: row.runnerId,
        workspaceId: row.workspaceId,
        generation: row.generation,
        issuedAt: at,
        // The runner finishes the handover by the command's expiry, or reports it could not.
        expiresAt: at + RUNNER_HANDOVER_LIMIT_MS,
      });
      const after = db
        .query<{ sequence: number }, [string, number]>(
          "SELECT COALESCE(MAX(sequence),0) AS sequence FROM runner_event WHERE run_id=? AND generation=?",
        )
        .get(row.runId, row.generation)!.sequence;
      return { ...row, after, deadline: at + RUNNER_HANDOVER_LIMIT_MS + DELIVERY_GRACE_MS };
    });
    if (!request) return { status: "not_running" };
    if (request === "old_runner") return { status: "old_runner" };
    let deadline = request.deadline;
    while (now() < deadline) {
      signal?.throwIfAborted();
      const stored = db
        .query<{ payload: string }, [string, number]>(
          "SELECT payload FROM runner_result WHERE run_id=? AND generation=?",
        )
        .get(request.runId, request.generation);
      const result = stored ? RunnerResultSchema.parse(JSON.parse(stored.payload)) : null;
      if (result?.handoverFailure) return { status: "failed", reason: result.handoverFailure };
      if (result && !result.handedOver) return { status: "finished" };
      // The attempt ends the work once it has imported the WIP commit, or once it failed to.
      if (
        result &&
        db
          .query(
            "SELECT 1 FROM runner_work WHERE run_id=? AND generation=? AND ended_at IS NOT NULL",
          )
          .get(request.runId, request.generation)
      ) {
        const wipCommit = result.candidateSha ?? null;
        return wipCommit === null || getWorkItem(db, itemId)?.checkpoint?.wipCommit === wipCommit
          ? { status: "handed_over", wipCommit }
          : { status: "unanswered" };
      }
      const events = result
        ? []
        : db
            .query<
              { type: string; handedOver: number | null; reason: string | null },
              [string, number, number]
            >(
              `SELECT json_extract(payload,'$.type') AS type,
               json_extract(payload,'$.handedOver') AS handedOver,
               json_extract(payload,'$.reason') AS reason FROM runner_event
               WHERE run_id=? AND generation=? AND sequence>?
               AND json_extract(payload,'$.type') IN ('handover','handover_interrupted')
               ORDER BY sequence`,
            )
            .all(request.runId, request.generation, request.after);
      const failure = events.find((event) => event.type === "handover" && !event.handedOver);
      if (failure?.reason === "timeout") return { status: "timed_out" };
      if (failure) return { status: "failed", reason: failure.reason as RunnerHandoverFailure };
      // The agent stopped: only the commit, the snapshot and their publication are left.
      if (events.length) deadline = Math.max(deadline, request.deadline + PUBLICATION_WAIT_MS);
      await delay(options.pollIntervalMs ?? 250, undefined, { signal });
    }
    return { status: "unanswered" };
  };
}
