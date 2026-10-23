import type { Database } from "bun:sqlite";

export type IntegrationEvent = {
  deliveryId: string;
  event: string;
  payload: string;
  receivedAt: number;
};

const GITHUB_DELIVERY_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export function recordGitHubDelivery(
  db: Database,
  input: Omit<IntegrationEvent, "receivedAt">,
  now = Date.now(),
): boolean {
  const result = db.run(
    `INSERT INTO github_delivery (delivery_id, event, payload, received_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(delivery_id) DO NOTHING`,
    [input.deliveryId, input.event, input.payload, now],
  );
  db.run("DELETE FROM github_delivery WHERE received_at < ?", [now - GITHUB_DELIVERY_KEEP_MS]);
  return result.changes > 0;
}

export function latestGitHubDelivery(
  db: Database,
): Pick<IntegrationEvent, "event" | "receivedAt"> | null {
  return db
    .query<{ event: string; receivedAt: number }, []>(
      "SELECT event, received_at AS receivedAt FROM github_delivery ORDER BY received_at DESC LIMIT 1",
    )
    .get();
}

export function listGitHubDeliveries(db: Database): IntegrationEvent[] {
  return db
    .query<{ delivery_id: string; event: string; payload: string; received_at: number }, []>(
      "SELECT delivery_id, event, payload, received_at FROM github_delivery ORDER BY received_at, delivery_id",
    )
    .all()
    .map((row) => ({
      deliveryId: row.delivery_id,
      event: row.event,
      payload: row.payload,
      receivedAt: row.received_at,
    }));
}
