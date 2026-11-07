import type { Database } from "bun:sqlite";
import { asc, desc, lt } from "drizzle-orm";
import { orm } from "./orm";
import { githubDelivery } from "./schema";

export type IntegrationEvent = {
  deliveryId: string;
  event: string;
  payload: string;
  receivedAt: number;
};

const GITHUB_DELIVERY_KEEP_MS = 3 * 24 * 60 * 60 * 1000;

export function recordGitHubDelivery(
  db: Database,
  input: Omit<IntegrationEvent, "receivedAt">,
  now = Date.now(),
): boolean {
  // Raw: src/loop/github-delivery-atomic.test.ts fails this exact INSERT through db.run.
  const result = db.run(
    `INSERT INTO github_delivery (delivery_id, event, payload, received_at)
    VALUES (?, ?, '', ?) ON CONFLICT(delivery_id) DO NOTHING`,
    [input.deliveryId, input.event, now],
  );
  orm(db)
    .delete(githubDelivery)
    .where(lt(githubDelivery.receivedAt, now - GITHUB_DELIVERY_KEEP_MS))
    .run();
  return result.changes > 0;
}

export function latestGitHubDelivery(
  db: Database,
): Pick<IntegrationEvent, "event" | "receivedAt"> | null {
  return (
    orm(db)
      .select({ event: githubDelivery.event, receivedAt: githubDelivery.receivedAt })
      .from(githubDelivery)
      .orderBy(desc(githubDelivery.receivedAt))
      .limit(1)
      .get() ?? null
  );
}

export function listGitHubDeliveries(db: Database): IntegrationEvent[] {
  return orm(db)
    .select()
    .from(githubDelivery)
    .orderBy(asc(githubDelivery.receivedAt), asc(githubDelivery.deliveryId))
    .all();
}
