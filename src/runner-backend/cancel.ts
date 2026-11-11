import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Database } from "bun:sqlite";
import { RunnerCapacityWait } from "../core";
import {
  itemOpenRunnerWorkRunsSteps,
  itemRunnerCancelWorkSteps,
  pendingRunnerCancelSteps,
  runTeardownOwnerSteps,
  sqliteDb,
  type Db,
} from "../db";
import type { RunnerWork } from "../runner-work";

export function createRemoteCancellation(options: {
  db: Database;
  store?: Db;
  work: RunnerWork;
  now?: () => number;
  pollIntervalMs?: number;
  /** Publishes a running run's work as a WIP commit before the cancel stops it. */
  checkpoint?: (runId: string) => Promise<unknown> | null;
}) {
  const { db, work } = options;
  const store = options.store ?? sqliteDb(db);
  const now = options.now ?? Date.now;
  return async function cancelItem(itemId: string, signal?: AbortSignal): Promise<void> {
    if (options.checkpoint) {
      const running = await store.run((q) => itemOpenRunnerWorkRunsSteps(q, itemId));
      const waiting = running.map((row) => options.checkpoint!(row.runId)).filter(Boolean);
      if (waiting.length) await Promise.all(waiting);
    }
    const requests = await store.transaction(function* (q) {
      const rows = yield* itemRunnerCancelWorkSteps(q, itemId);
      const out: { runId: string; runnerId: string; validUntil: number; deadline: number }[] = [];
      for (const row of rows) {
        const at = now();
        if (!row.requested) {
          if ((yield* runTeardownOwnerSteps(q, row.runId)) === null) continue;
          out.push({
            runId: row.runId,
            runnerId: row.runnerId,
            validUntil: at + 65_000,
            deadline: performance.now() + 65_000,
          });
          continue;
        }
        const expiresAt = Math.max(row.leaseUntil + 65_000, at + 65_000);
        const previous = yield* pendingRunnerCancelSteps(q, {
          runId: row.runId,
          runnerId: row.runnerId,
          generation: row.generation,
          now: at,
        });
        const id = previous?.id ?? randomUUID();
        if (!previous) {
          try {
            yield* work.enqueueSteps(q, {
              runId: row.runId,
              runnerId: row.runnerId,
              workspaceId: row.workspaceId,
              generation: row.generation,
              id,
              type: "cancel",
              issuedAt: at,
              expiresAt,
            });
          } catch {
            throw new Error("Runner cancellation could not be delivered");
          }
        }
        const validUntil = previous?.expiresAt ?? expiresAt;
        out.push({
          runId: row.runId,
          runnerId: row.runnerId,
          validUntil,
          deadline: performance.now() + validUntil - at,
        });
      }
      return out;
    });
    await Promise.all(
      requests.map(async ({ runId, runnerId, deadline, validUntil }) => {
        while (performance.now() < deadline && now() < validUntil) {
          signal?.throwIfAborted();
          if ((await store.run((q) => runTeardownOwnerSteps(q, runId))) === null) return;
          await delay(options.pollIntervalMs ?? 250, undefined, { signal });
        }
        throw new RunnerCapacityWait([runnerId]);
      }),
    );
  };
}
