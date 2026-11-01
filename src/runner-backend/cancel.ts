import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Database } from "bun:sqlite";
import { RunnerCapacityWait } from "../core";
import { immediate } from "../db";
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
      const running = db
        .query<{ runId: string }, [string]>(
          `SELECT w.run_id AS runId FROM runner_work w JOIN run r ON r.id=w.run_id
           WHERE r.item_id=? AND w.ended_at IS NULL`,
        )
        .all(itemId);
      const waiting = running.map((row) => options.checkpoint!(row.runId)).filter(Boolean);
      if (waiting.length) await Promise.all(waiting);
    }
    const requests = immediate(db, () => {
      const rows = db
        .query<
          {
            runId: string;
            runnerId: string;
            workspaceId: string;
            generation: number;
            leaseUntil: number;
          },
          [string]
        >(
          `SELECT w.run_id AS runId,w.runner_id AS runnerId,w.workspace_id AS workspaceId,
           w.generation,w.lease_until AS leaseUntil FROM runner_work w JOIN run r ON r.id=w.run_id
           WHERE r.item_id=? AND (w.ended_at IS NULL OR EXISTS (
             SELECT 1 FROM runner_command c WHERE c.run_id=w.run_id AND c.generation=w.generation
             AND c.runner_id=w.runner_id AND c.kind='cancel' AND c.acknowledged_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM runner_command a WHERE a.runner_id=c.runner_id AND a.run_id=c.run_id
               AND a.generation=c.generation AND a.kind='cancel' AND a.ordinal>c.ordinal AND a.acknowledged_at IS NOT NULL)))`,
        )
        .all(itemId);
      return rows.flatMap((row) => {
        const at = now();
        const expiresAt = Math.max(row.leaseUntil + 65_000, at + 65_000);
        const previous = db
          .query<{ id: string; expiresAt: number }, [string, string, number, number]>(
            `SELECT id,expires_at AS expiresAt FROM runner_command WHERE run_id=? AND runner_id=? AND generation=?
             AND kind='cancel' AND acknowledged_at IS NULL AND expires_at>?
             ORDER BY ordinal DESC LIMIT 1`,
          )
          .get(row.runId, row.runnerId, row.generation, at);
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
          { id, runnerId: row.runnerId, validUntil, deadline: performance.now() + validUntil - at },
        ];
      });
    });
    await Promise.all(
      requests.map(async ({ id, runnerId, deadline, validUntil }) => {
        while (performance.now() < deadline && now() < validUntil) {
          signal?.throwIfAborted();
          const command = db
            .query<{ acknowledged: number | null }, [string]>(
              "SELECT acknowledged_at AS acknowledged FROM runner_command WHERE id=?",
            )
            .get(id);
          if (command?.acknowledged !== null && command?.acknowledged !== undefined) return;
          await delay(options.pollIntervalMs ?? 250, undefined, { signal });
        }
        throw new RunnerCapacityWait([runnerId]);
      }),
    );
  };
}
