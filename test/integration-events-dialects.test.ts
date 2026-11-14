import { expect, test } from "bun:test";
import { latestGitHubDeliverySteps, recordGitHubDeliverySteps } from "../src/db";
import { forEachDialect, githubDeliveryRows } from "./dialects";

const DAY_MS = 24 * 60 * 60 * 1000;

forEachDialect((open) => {
  test("a GitHub delivery is recorded once and old ones are pruned", async () => {
    const { db, close } = await open();
    try {
      const record = (deliveryId: string, event: string, now: number) =>
        db.run((q) => recordGitHubDeliverySteps(q, { deliveryId, event }, now));
      expect(await db.run(latestGitHubDeliverySteps)).toBeNull();
      expect(await record("old", "push", 0)).toBe(true);
      expect(await record("b", "pull_request", 14 * DAY_MS)).toBe(true);
      expect(await record("a", "push", 14 * DAY_MS)).toBe(true);
      expect(await record("a", "push", 14 * DAY_MS + 1)).toBe(false);
      expect(await githubDeliveryRows(db)).toEqual([
        { deliveryId: "a", event: "push", receivedAt: 14 * DAY_MS },
        { deliveryId: "b", event: "pull_request", receivedAt: 14 * DAY_MS },
      ]);
      await record("c", "check_run", 14 * DAY_MS + 5);
      expect(await db.run(latestGitHubDeliverySteps)).toEqual({
        event: "check_run",
        receivedAt: 14 * DAY_MS + 5,
      });
    } finally {
      await close();
    }
  });
});
