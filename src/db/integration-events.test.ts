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
    {
      deliveryId: "d-1",
      event: "check_run",
      receivedAt: 1_000,
      repository: null,
      pullNumber: null,
    },
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

test("receipts keep normalized pull metadata without retaining webhook bodies", async () => {
  const db = (await tempStore()).db;
  for (const [deliveryId, body, pullNumber] of [
    ["review", { repository: { full_name: "Acme/App" }, pull_request: { number: 7 } }, 7],
    ["comment", { repository: { full_name: "Acme/App" }, issue: { number: 8 } }, 8],
    ["string", { repository: { full_name: "Acme/App" }, issue: { number: "7" } }, null],
  ] as const) {
    await recordGitHubDelivery(
      db,
      { deliveryId, event: "issue_comment", payload: JSON.stringify(body) },
      1000,
    );
    expect((await githubDeliveryRows(db)).find((row) => row.deliveryId === deliveryId)).toEqual({
      deliveryId,
      event: "issue_comment",
      repository: "acme/app",
      pullNumber,
      receivedAt: 1000,
    });
  }
});
