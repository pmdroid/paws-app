import type { Database } from "bun:sqlite";
import { and, eq, isNotNull, notInArray } from "drizzle-orm";
import { TERMINAL_WORK_ITEM_STATES } from "../core";
import { settled, sqliteDb, type Q } from "./db";

export const LINEAR_WEBHOOK_SILENCE_MS = 60 * 60_000;

export const LINEAR_WEBHOOK_FIX =
  "In Linear, open Settings > API > Applications > Paws, re-enable its webhook at https://YOUR-PAWS-HOST/webhooks/linear, and check its recent deliveries.";

export type LinearWebhookWarning = {
  reason: "missed" | "silent";
  lastVerifiedMs: number;
  missedMs: number | null;
};

export function* linearWebhookWarningSteps(q: Q, nowMs: number) {
  const lastVerifiedMs = yield* cursorSteps(q, "linear:webhook");
  if (lastVerifiedMs === null) return null;
  const missedMs = yield* cursorSteps(q, "linear:webhook-missed");
  if (missedMs !== null && missedMs > lastVerifiedMs)
    return { reason: "missed", lastVerifiedMs, missedMs } satisfies LinearWebhookWarning;
  if (nowMs - lastVerifiedMs <= LINEAR_WEBHOOK_SILENCE_MS) return null;
  const { workItem } = q.t;
  const active = yield* q.one(
    q.orm
      .select({ id: workItem.id })
      .from(workItem)
      .where(
        and(
          isNotNull(workItem.sessionKey),
          notInArray(workItem.state, [...TERMINAL_WORK_ITEM_STATES]),
        ),
      )
      .limit(1),
  );
  return active === undefined
    ? null
    : ({ reason: "silent", lastVerifiedMs, missedMs } satisfies LinearWebhookWarning);
}

export function linearWebhookWarning(db: Database, nowMs: number): LinearWebhookWarning | null {
  return settled(sqliteDb(db).run((q) => linearWebhookWarningSteps(q, nowMs)));
}

export function describeLinearWebhookWarning(warning: LinearWebhookWarning): string {
  return warning.reason === "missed"
    ? "Linear may have disabled the Paws webhook: the catch-up poll found events no webhook delivered."
    : "Linear may have disabled the Paws webhook: no verified delivery for over an hour while sessions are active.";
}

function* cursorSteps(q: Q, name: string) {
  const { syncCursor } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ cursorMs: syncCursor.cursorMs })
      .from(syncCursor)
      .where(eq(syncCursor.name, name)),
  );
  return row?.cursorMs ?? null;
}
