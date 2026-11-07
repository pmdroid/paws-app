import type { Database } from "bun:sqlite";
import { asc, desc, lt } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";

export type IntegrationEvent = {
  deliveryId: string;
  event: string;
  payload: string;
  receivedAt: number;
};

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

export function recordGitHubDelivery(
  db: Database,
  input: Omit<IntegrationEvent, "receivedAt">,
  now = Date.now(),
): boolean {
  return settled(sqliteDb(db).run((q) => recordGitHubDeliverySteps(q, input, now)));
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

export function latestGitHubDelivery(
  db: Database,
): Pick<IntegrationEvent, "event" | "receivedAt"> | null {
  return settled(sqliteDb(db).run(latestGitHubDeliverySteps));
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

export function listGitHubDeliveries(db: Database): IntegrationEvent[] {
  return settled(sqliteDb(db).run(listGitHubDeliveriesSteps));
}
