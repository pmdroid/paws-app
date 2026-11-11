import { asc, desc, eq, lt } from "drizzle-orm";
import { type Q, type Db } from "./db";
import type { githubDelivery } from "./schema";

export type IntegrationEvent = typeof githubDelivery.$inferSelect;

const GITHUB_DELIVERY_KEEP_MS = 3 * 24 * 60 * 60 * 1000;

export function* recordGitHubDeliverySteps(
  q: Q,
  input: Omit<IntegrationEvent, "receivedAt">,
  now = Date.now(),
) {
  const { githubDelivery } = q.t;
  const inserted = yield* q.all(
    q.orm
      .insert(githubDelivery)
      .values({
        deliveryId: input.deliveryId,
        event: input.event,
        payload: input.payload,
        receivedAt: now,
      })
      .onConflictDoNothing({ target: githubDelivery.deliveryId })
      .returning({ deliveryId: githubDelivery.deliveryId }),
  );
  yield* q.exec(
    q.orm
      .delete(githubDelivery)
      .where(lt(githubDelivery.receivedAt, now - GITHUB_DELIVERY_KEEP_MS)),
  );
  return inserted.length > 0;
}

export async function recordGitHubDelivery(
  store: Db,
  input: Omit<IntegrationEvent, "receivedAt">,
  now = Date.now(),
): Promise<boolean> {
  return store.run((q) => recordGitHubDeliverySteps(q, input, now));
}

export function* latestGitHubDeliverySteps(q: Q) {
  const { githubDelivery } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ event: githubDelivery.event, receivedAt: githubDelivery.receivedAt })
      .from(githubDelivery)
      .orderBy(desc(githubDelivery.receivedAt))
      .limit(1),
  );
  return row ?? null;
}

export async function latestGitHubDelivery(
  store: Db,
): Promise<Pick<IntegrationEvent, "event" | "receivedAt"> | null> {
  return store.run((q) => latestGitHubDeliverySteps(q));
}

export function* listGitHubDeliveriesSteps(q: Q) {
  const { githubDelivery } = q.t;
  return yield* q.all(
    q.orm
      .select()
      .from(githubDelivery)
      .orderBy(asc(githubDelivery.receivedAt), asc(githubDelivery.deliveryId)),
  );
}

export async function listGitHubDeliveries(store: Db): Promise<IntegrationEvent[]> {
  return store.run((q) => listGitHubDeliveriesSteps(q));
}

export function* githubDeliveryRecordedSteps(q: Q, deliveryId: string) {
  const { githubDelivery } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ deliveryId: githubDelivery.deliveryId })
      .from(githubDelivery)
      .where(eq(githubDelivery.deliveryId, deliveryId)),
  );
  return row !== undefined;
}

export async function githubDeliveryRecorded(store: Db, deliveryId: string): Promise<boolean> {
  return store.run((q) => githubDeliveryRecordedSteps(q, deliveryId));
}
