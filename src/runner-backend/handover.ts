import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Database } from "bun:sqlite";
import { getWorkItem, immediate } from "../db";
import { RUNNER_HANDOVER_MS, RunnerResultSchema } from "../runner-protocol";
import { RUNNER_HANDOVER_SEAL_GRACE_MS } from "../runner-transcripts";
import type { RunnerWork } from "../runner-work";

/** After the runner's result, how long Paws waits for the run to import the WIP commit. */
const HANDOVER_IMPORT_MS = 2 * 60_000;
/**
 * A handover commits when Paws seals its transcript, which Paws allows only until
 * `RUNNER_HANDOVER_SEAL_GRACE_MS` after the deadline. Paws waits a little longer than that, so
 * a handover it reports as failed can no longer commit, and the session stays on the runner.
 */
const HANDOVER_RESULT_GRACE_MS = RUNNER_HANDOVER_SEAL_GRACE_MS + 15_000;
/** After the seal, how long Paws waits for the runner to post its handed-over result. */
const HANDOVER_COMMITTED_MS = 5 * 60_000;

export type RunnerHandoverOutcome =
  | { handedOver: true; runnerId: string; wipCommit?: string }
  | { handedOver: false; runnerId?: string; reason: string };

/**
 * Asks the runner that runs the item's implementation to hand the session over. The runner
 * stops the agent at a safe point, publishes a WIP commit and the transcript, and ends the run
 * with a `handedOver` result. The run that is attached to the work imports the commit as the
 * item's checkpoint. A handover that does not finish in time is reported, and the session
 * stays on the runner.
 */
export function createRemoteHandover(options: {
  db: Database;
  work: RunnerWork;
  now?: () => number;
  pollIntervalMs?: number;
  /** How long the runner has for the handover. Tests shorten it. */
  handoverMs?: number;
  handoverGraceMs?: number;
}) {
  const { db, work } = options;
  const limit = Math.min(options.handoverMs ?? RUNNER_HANDOVER_MS, RUNNER_HANDOVER_MS);
  const now = options.now ?? Date.now;
  const interval = options.pollIntervalMs ?? 250;
  return async function handoverItem(
    itemId: string,
    signal?: AbortSignal,
  ): Promise<RunnerHandoverOutcome> {
    const request = immediate(db, () => {
      const runId = getWorkItem(db, itemId)?.currentRunId;
      if (!runId) return null;
      const row = db
        .query<
          { runnerId: string; workspaceId: string; generation: number; commandId: string },
          [string]
        >(
          `SELECT w.runner_id AS runnerId,w.workspace_id AS workspaceId,w.generation,
           w.command_id AS commandId FROM runner_work w JOIN runner_command c ON c.id=w.command_id
           WHERE w.run_id=? AND w.ended_at IS NULL AND c.kind='run'`,
        )
        .get(runId);
      if (!row) return null;
      const issuedAt = now();
      const id = randomUUID();
      work.enqueue({
        id,
        type: "handover",
        runId,
        runnerId: row.runnerId,
        workspaceId: row.workspaceId,
        generation: row.generation,
        issuedAt,
        expiresAt: issuedAt + limit,
      });
      return {
        ...row,
        runId,
        id,
        waitUntil: issuedAt + limit + (options.handoverGraceMs ?? HANDOVER_RESULT_GRACE_MS),
      };
    });
    if (!request) return { handedOver: false, reason: "The task has no running session." };
    const { runId, generation, runnerId, commandId } = request;
    const result = () => {
      const row = db
        .query<{ payload: string }, [string, number, string]>(
          "SELECT payload FROM runner_result WHERE run_id=? AND generation=? AND command_id=?",
        )
        .get(runId, generation, commandId);
      return row ? RunnerResultSchema.parse(JSON.parse(row.payload)) : null;
    };
    const ended = () =>
      db
        .query<{ endedAt: number | null }, [string, number]>(
          "SELECT ended_at AS endedAt FROM runner_work WHERE run_id=? AND generation=?",
        )
        .get(runId, generation)?.endedAt !== null;
    const sealed = () =>
      db
        .query<{ sealed: number | null }, [string, number]>(
          "SELECT sealed_size AS sealed FROM runner_transcript WHERE run_id=? AND generation=?",
        )
        .get(runId, generation)?.sealed != null;
    let finished = result();
    let committedSince: number | undefined;
    while (!finished) {
      if (committedSince === undefined && sealed()) committedSince = performance.now();
      // Without a seal by the deadline the handover can no longer commit.
      if (committedSince === undefined && now() >= request.waitUntil) break;
      // After the seal, the result follows unless the runner loses the run.
      if (
        committedSince !== undefined &&
        (ended() || performance.now() - committedSince >= HANDOVER_COMMITTED_MS)
      )
        return {
          handedOver: false,
          runnerId,
          reason:
            "The runner committed the handover, but its result has not arrived. Check the runner.",
        };
      signal?.throwIfAborted();
      await delay(interval, undefined, { signal });
      finished = result();
    }
    if (!finished)
      return {
        handedOver: false,
        runnerId,
        reason:
          "The runner did not hand over the session within 2 minutes. The session stays on the runner.",
      };
    if (!finished.handedOver)
      return {
        handedOver: false,
        runnerId,
        reason: "The session ended on the runner before it could be handed over.",
      };
    const importBy = performance.now() + HANDOVER_IMPORT_MS;
    while (!ended() && performance.now() < importBy) {
      signal?.throwIfAborted();
      await delay(interval, undefined, { signal });
    }
    if (!ended())
      return {
        handedOver: false,
        runnerId,
        reason: "Paws did not import the handed-over work in time.",
      };
    const wipCommit = getWorkItem(db, itemId)?.checkpoint?.wipCommit;
    return { handedOver: true, runnerId, ...(wipCommit ? { wipCommit } : {}) };
  };
}
