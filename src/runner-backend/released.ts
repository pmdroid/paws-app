import type { Database } from "bun:sqlite";
import { RUNNER_LIVE_GRACE_MS } from "../runner-work";

/**
 * Whether every runner command of the item is known to be gone since `since`: Paws ended it,
 * and the runner it ran on has since named the work it still runs without naming this one. A
 * runner that restarted reports this on its first heartbeat; one that still names the command
 * keeps it. False when the item never ran on a runner, so only a person can vouch for it.
 */
export function remoteCommandsGone(db: Database, itemId: string, since: number): boolean {
  const rows = db
    .query<
      {
        endedAt: number | null;
        confirmedAt: number | null;
        reportedAt: number | null;
        acknowledgedAt: number | null;
        expiresAt: number | null;
      },
      [string]
    >(
      `SELECT w.ended_at AS endedAt,w.confirmed_at AS confirmedAt,n.live_reported_at AS reportedAt,
       c.acknowledged_at AS acknowledgedAt,c.expires_at AS expiresAt
       FROM runner_work w JOIN run r ON r.id=w.run_id JOIN runner n ON n.id=w.runner_id
       LEFT JOIN runner_command c ON c.id=w.command_id
       WHERE r.item_id=?`,
    )
    .all(itemId);
  return (
    rows.length > 0 &&
    rows.every(
      (row) =>
        row.endedAt !== null &&
        row.reportedAt !== null &&
        row.reportedAt >= since &&
        row.reportedAt >= row.endedAt &&
        (row.confirmedAt === null || row.confirmedAt < row.reportedAt) &&
        // A command acknowledged just before the report may not be in it yet.
        (row.acknowledgedAt !== null
          ? row.reportedAt >= row.acknowledgedAt + RUNNER_LIVE_GRACE_MS
          : row.expiresAt !== null && row.reportedAt >= row.expiresAt),
    )
  );
}
