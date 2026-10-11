import type { Database } from "bun:sqlite";

export type IntegrationEvent = {
  deliveryId: string;
  event: string;
  payload: string;
  receivedAt: number;
};

export function recordGitHubDelivery(
  db: Database,
  input: Omit<IntegrationEvent, "receivedAt">,
): void {
  db.run(
    `INSERT INTO github_delivery (delivery_id, event, payload, received_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(delivery_id) DO NOTHING`,
    [input.deliveryId, input.event, input.payload, Date.now()],
  );
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
