import type { Database } from "bun:sqlite";
import { DEFAULT_MAX_AWAKE_MS } from "../core";
import { configureWorkItem, enqueueOutboxOnce, resetAwakeTime } from "../db";

export function freshBudgetLine(maxAwakeMs: number): string {
  const minutes = Math.max(1, Math.round(maxAwakeMs / 60_000));
  const limit = minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`;
  return `Starting on your request with a fresh ${limit} time limit.`;
}

export function startFreshBudget(
  db: Database,
  input: {
    itemId: string;
    sessionId: string | null;
    key: string;
    maxAwakeMs?: number;
    now: number;
  },
): void {
  const maxAwakeMs = input.maxAwakeMs ?? DEFAULT_MAX_AWAKE_MS;
  resetAwakeTime(db, input.itemId);
  configureWorkItem(db, input.itemId, { maxAwakeMs });
  if (input.sessionId === null) return;
  enqueueOutboxOnce(db, {
    target: "linear",
    op: "activity",
    orderingKey: input.sessionId,
    idempotencyKey: `fresh-budget:${input.key}`,
    payload: { sessionId: input.sessionId, kind: "thought", body: freshBudgetLine(maxAwakeMs) },
    now: input.now,
  });
}
