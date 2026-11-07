import { expect, test } from "bun:test";
import { listGitHubDeliveries, migrate, openDatabase, recordGitHubDelivery } from "./index";

const DAY = 24 * 60 * 60 * 1000;

test("a GitHub delivery keeps its id, event, time and payload", () => {
  const db = openDatabase(":memory:");
  migrate(db);
  expect(
    recordGitHubDelivery(
      db,
      { deliveryId: "d-1", event: "check_run", payload: "x".repeat(20_000) },
      1_000,
    ),
  ).toBe(true);
  expect(
    recordGitHubDelivery(db, { deliveryId: "d-1", event: "check_run", payload: "{}" }, 2_000),
  ).toBe(false);
  expect(listGitHubDeliveries(db)).toEqual([
    { deliveryId: "d-1", event: "check_run", payload: "x".repeat(20_000), receivedAt: 1_000 },
  ]);
});

test("GitHub deliveries and their payloads older than three days are deleted", () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const now = 10 * DAY;
  recordGitHubDelivery(
    db,
    { deliveryId: "old", event: "check_run", payload: "{}" },
    now - 3 * DAY - 1,
  );
  recordGitHubDelivery(
    db,
    { deliveryId: "recent", event: "check_run", payload: "{}" },
    now - 3 * DAY + 1,
  );
  recordGitHubDelivery(db, { deliveryId: "new", event: "check_run", payload: "{}" }, now);
  expect(listGitHubDeliveries(db).map((row) => row.deliveryId)).toEqual(["recent", "new"]);
});
