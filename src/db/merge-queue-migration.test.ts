import { expect, test } from "bun:test";
import { insertQueuedItem, listMergeQueues, migrate, openDatabase } from "./index";

test("normalizing old queue rows preserves order, kept places and notification metadata", () => {
  const db = openDatabase(":memory:");
  migrate(db, { until: "20261029T1559_opencode_agent_rows" });
  for (const [id, repository] of [
    ["first", "Acme/APP"],
    ["second", "acme/app"],
  ]) {
    insertQueuedItem(db, { id: id!, now: 1 });
    db.run("UPDATE work_item SET state='merge_queue' WHERE id=?", [id!]);
    db.run(
      "INSERT INTO merge_queue_entry(item_id,repository,ready_at,kept,notified_position) VALUES (?,?,1,1,2)",
      [id!, repository!],
    );
  }
  const before = db
    .query("SELECT id,item_id,ready_at,kept,notified_position FROM merge_queue_entry ORDER BY id")
    .all();
  migrate(db);
  expect(
    db
      .query("SELECT id,item_id,ready_at,kept,notified_position FROM merge_queue_entry ORDER BY id")
      .all(),
  ).toEqual(before);
  expect(listMergeQueues(db).map((e) => [e.itemId, e.repository, e.position])).toEqual([
    ["first", "acme/app", 1],
    ["second", "acme/app", 2],
  ]);
  migrate(db);
  expect(listMergeQueues(db)).toHaveLength(2);
  db.close();
});
