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
  const inserted = orm(db)
    .insert(githubDelivery)
    .values({
      deliveryId: input.deliveryId,
      event: input.event,
      payload: input.payload,
      receivedAt: now,
    })
    .onConflictDoNothing({ target: githubDelivery.deliveryId })
    .returning({ deliveryId: githubDelivery.deliveryId })
    .all();
  orm(db)
    .delete(githubDelivery)
    .where(lt(githubDelivery.receivedAt, now - GITHUB_DELIVERY_KEEP_MS))
    .run();
  return inserted.length > 0;
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
