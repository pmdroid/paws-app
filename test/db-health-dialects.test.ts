import { expect, test } from "bun:test";
import {
  databaseProbeSteps,
  deadJobCountSteps,
  deadOutboxCountSteps,
  expiredJobLeaseCountSteps,
  latestGithubDeliverySteps,
  runnerHeartbeatsSteps,
  type Q,
} from "../src/db";
import { forEachDialect, json, seed, withoutForeignKeys } from "./dialects";

const NOW = 1_000_000;

function job(q: Q, status: string, lockedUntil: number | null) {
  return q.orm
    .insert(q.t.job)
    .values({ queue: "general", runAt: 0, createdAt: 0, status, lockedUntil });
}

function runner(q: Q, id: string, status: string, lastSeenAt: number | null, revokedAt = null) {
  return q.orm.insert(q.t.runner).values({
    id,
    workspaceId: "acme",
    ownerUserId: "owner",
    name: id,
    status,
    createdAt: 0,
    lastSeenAt,
    revokedAt,
  });
}

forEachDialect((open) => {
  test("the health reads count the same rows on either dialect", async () => {
    const { db, close } = await open();
    try {
      await withoutForeignKeys(db);
      await db.run(databaseProbeSteps);
      expect(await db.run(latestGithubDeliverySteps)).toBeNull();
      expect(await db.run((q) => runnerHeartbeatsSteps(q, NOW))).toEqual({
        total: 0,
        stale: 0,
        oldest: null,
      });
      await seed(
        db,
        (q) => job(q, "running", null),
        (q) => job(q, "running", NOW),
        (q) => job(q, "running", NOW + 1),
        (q) => job(q, "dead", null),
        (q) => job(q, "done", null),
        (q) =>
          q.orm.insert(q.t.outbox).values({
            target: "linear",
            op: "comment",
            idempotencyKey: "dead",
            payload: json(db, {}) as never,
            status: "dead",
            createdAt: 0,
          }),
        (q) => runner(q, "fresh", "active", NOW + 5),
        (q) => runner(q, "stale", "active", NOW - 5),
        (q) => runner(q, "silent", "active", null),
        (q) => runner(q, "paused", "paused", 0),
        (q) =>
          q.orm.insert(q.t.githubDelivery).values([
            { deliveryId: "a", event: "push", payload: "{}", receivedAt: 7 },
            { deliveryId: "b", event: "push", payload: "{}", receivedAt: 9 },
          ]),
      );
      expect(await db.run((q) => expiredJobLeaseCountSteps(q, NOW))).toBe(2);
      expect(await db.run(deadJobCountSteps)).toBe(1);
      expect(await db.run(deadOutboxCountSteps)).toBe(1);
      expect(await db.run((q) => runnerHeartbeatsSteps(q, NOW))).toEqual({
        total: 3,
        stale: 2,
        oldest: NOW - 5,
      });
      expect(await db.run(latestGithubDeliverySteps)).toBe(9);
    } finally {
      await close();
    }
  });
});
