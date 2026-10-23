import type { Database } from "bun:sqlite";
import { TERMINAL_WORK_ITEM_STATES } from "../core";

export const LINEAR_WEBHOOK_SILENCE_MS = 60 * 60_000;

export const LINEAR_WEBHOOK_FIX =
  "In Linear, open Settings > API > Applications > Paws, re-enable its webhook at https://YOUR-PAWS-HOST/webhooks/linear, and check its recent deliveries.";

export type LinearWebhookWarning = {
  reason: "missed" | "silent";
  lastVerifiedMs: number;
  missedMs: number | null;
};

export function linearWebhookWarning(db: Database, nowMs: number): LinearWebhookWarning | null {
  const lastVerifiedMs = cursor(db, "linear:webhook");
  if (lastVerifiedMs === null) return null;
  const missedMs = cursor(db, "linear:webhook-missed");
  if (missedMs !== null && missedMs > lastVerifiedMs)
    return { reason: "missed", lastVerifiedMs, missedMs };
  if (nowMs - lastVerifiedMs <= LINEAR_WEBHOOK_SILENCE_MS) return null;
  const terminal = TERMINAL_WORK_ITEM_STATES.map(() => "?").join(", ");
  const active = db
    .query(
      `SELECT 1 FROM work_item WHERE session_key IS NOT NULL AND state NOT IN (${terminal}) LIMIT 1`,
    )
    .get(...TERMINAL_WORK_ITEM_STATES);
  return active === null ? null : { reason: "silent", lastVerifiedMs, missedMs };
}

export function describeLinearWebhookWarning(warning: LinearWebhookWarning): string {
  return warning.reason === "missed"
    ? "Linear may have disabled the Paws webhook: the catch-up poll found events no webhook delivered."
    : "Linear may have disabled the Paws webhook: no verified delivery for over an hour while sessions are active.";
}

function cursor(db: Database, name: string): number | null {
  return (
    db
      .query<{ cursor_ms: number }, [string]>("SELECT cursor_ms FROM sync_cursor WHERE name = ?")
      .get(name)?.cursor_ms ?? null
  );
}
