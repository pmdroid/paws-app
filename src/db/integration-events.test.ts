import { expect, test } from "bun:test";
import { recordGitHubDelivery } from "./index";
import { githubDeliveryRows } from "../../test/dialects";
import { tempStore } from "../../test/pglite";

const DAY = 24 * 60 * 60 * 1000;

test("a GitHub delivery keeps its id, event and time, and a repeated id is not recorded again", async () => {
  const db = (await tempStore()).db;
  expect(await recordGitHubDelivery(db, { deliveryId: "d-1", event: "check_run" }, 1_000)).toBe(
    true,
  );
  expect(await recordGitHubDelivery(db, { deliveryId: "d-1", event: "check_run" }, 2_000)).toBe(
    false,
  );
  expect(await githubDeliveryRows(db)).toEqual([
    { deliveryId: "d-1", event: "check_run", receivedAt: 1_000 },
  ]);
});

test("GitHub deliveries older than 14 days are deleted", async () => {
  const db = (await tempStore()).db;
  const now = 20 * DAY;
  await recordGitHubDelivery(db, { deliveryId: "old", event: "check_run" }, now - 14 * DAY - 1);
  await recordGitHubDelivery(db, { deliveryId: "recent", event: "check_run" }, now - 14 * DAY);
  await recordGitHubDelivery(db, { deliveryId: "new", event: "check_run" }, now);
  expect((await githubDeliveryRows(db)).map((row) => row.deliveryId)).toEqual(["recent", "new"]);
});
