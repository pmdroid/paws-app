import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Database } from "bun:sqlite";
import { RunnerCapacityWait } from "../core";
import {
  immediate,
  itemOpenRunnerWorkRuns,
  itemRunnerCancelWork,
  pendingRunnerCancel,
  runTeardownOwner,
} from "../db";
import type { RunnerWork } from "../runner-work";

export function createRemoteCancellation(options: {
  db: Database;
  work: RunnerWork;
  now?: () => number;
  pollIntervalMs?: number;
  /** Publishes a running run's work as a WIP commit before the cancel stops it. */
  checkpoint?: (runId: string) => Promise<unknown> | null;
}) {
  const { db, work } = options;
  const now = options.now ?? Date.now;
  return async function cancelItem(itemId: string, signal?: AbortSignal): Promise<void> {
    if (options.checkpoint) {
      const running = itemOpenRunnerWorkRuns(db, itemId);
      const waiting = running.map((row) => options.checkpoint!(row.runId)).filter(Boolean);
      if (waiting.length) await Promise.all(waiting);
    }
    const requests = immediate(db, () => {
      const rows = itemRunnerCancelWork(db, itemId);
      return rows.flatMap((row) => {
        const at = now();
        if (!row.requested) {
          if (runTeardownOwner(db, row.runId) === null) return [];
          return [
            {
              runId: row.runId,
              runnerId: row.runnerId,
              validUntil: at + 65_000,
              deadline: performance.now() + 65_000,
            },
          ];
        }
        const expiresAt = Math.max(row.leaseUntil + 65_000, at + 65_000);
        const previous = pendingRunnerCancel(db, {
          runId: row.runId,
          runnerId: row.runnerId,
          generation: row.generation,
          now: at,
        });
        const id = previous?.id ?? randomUUID();
        if (!previous) {
          try {
            work.enqueue({
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
        return [
          {
            runId: row.runId,
            runnerId: row.runnerId,
            validUntil,
            deadline: performance.now() + validUntil - at,
          },
        ];
      });
    });
    await Promise.all(
      requests.map(async ({ runId, runnerId, deadline, validUntil }) => {
        while (performance.now() < deadline && now() < validUntil) {
          signal?.throwIfAborted();
          if (runTeardownOwner(db, runId) === null) return;
          await delay(options.pollIntervalMs ?? 250, undefined, { signal });
        }
        throw new RunnerCapacityWait([runnerId]);
      }),
    );
  };
}
