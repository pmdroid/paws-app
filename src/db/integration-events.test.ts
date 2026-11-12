import { expect, test } from "bun:test";
import { listGitHubDeliveries, recordGitHubDelivery } from "./index";
import { tempStore } from "../../test/pglite";

const DAY = 24 * 60 * 60 * 1000;

test("a GitHub delivery keeps its id, event, time and payload", async () => {
  const db = (await tempStore()).db;
  expect(
    await recordGitHubDelivery(
      db,
      { deliveryId: "d-1", event: "check_run", payload: "x".repeat(20_000) },
      1_000,
    ),
  ).toBe(true);
  expect(
    await recordGitHubDelivery(db, { deliveryId: "d-1", event: "check_run", payload: "{}" }, 2_000),
  ).toBe(false);
  expect(await listGitHubDeliveries(db)).toEqual([
    { deliveryId: "d-1", event: "check_run", payload: "x".repeat(20_000), receivedAt: 1_000 },
  ]);
});

test("GitHub deliveries and their payloads older than three days are deleted", async () => {
  const db = (await tempStore()).db;
  const now = 10 * DAY;
  await recordGitHubDelivery(
    db,
    { deliveryId: "old", event: "check_run", payload: "{}" },
    now - 3 * DAY - 1,
  );
  await recordGitHubDelivery(
    db,
    { deliveryId: "recent", event: "check_run", payload: "{}" },
    now - 3 * DAY + 1,
  );
  await recordGitHubDelivery(db, { deliveryId: "new", event: "check_run", payload: "{}" }, now);
  expect((await listGitHubDeliveries(db)).map((row) => row.deliveryId)).toEqual(["recent", "new"]);
});
