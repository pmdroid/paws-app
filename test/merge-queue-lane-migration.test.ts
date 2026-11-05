import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../src/db";

test("existing merge queue entries join the repository-wide lane", () => {
  const db = new Database(":memory:");
  try {
    migrate(db, { until: "20261104T2030_item_blocker_check" });
    db.run(
      "INSERT INTO merge_queue_entry(item_id,repository,ready_at) VALUES('a','acme/monorepo',1),('b','acme/monorepo',2)",
    );
    migrate(db, { until: "20261105T0324_merge_queue_lane" });
    expect(
      db.query("SELECT item_id AS itemId, lane FROM merge_queue_entry ORDER BY id").all(),
    ).toEqual([
      { itemId: "a", lane: "" },
      { itemId: "b", lane: "" },
    ]);
  } finally {
    db.close();
  }
});
