import { expect, test } from "bun:test";
import {
  beginImplementRun,
  getWorkItem,
  insertQueuedItem,
  migrate,
  openDatabase,
  recoverOnStartup,
  requeueOrphanedWork,
} from "./index";
import { migration as correction } from "./migrations/20261101T0851_restart_decision_recovery";
import { migration } from "./migrations/20261101T0759_restart_decision";

for (const status of ["pending", "cancelled", "done"]) {
  test(`upgrade adopts an undelivered ${status} restart question`, () => {
    const db = openDatabase(":memory:");
    try {
      migrate(db);
      const item = insertQueuedItem(db, { sessionKey: "ses", now: 0 });
      beginImplementRun(db, item.id, 0);
      recoverOnStartup(db, 0);
      recoverOnStartup(db, 0);
      db.run("UPDATE job SET status=?,finished_at=0 WHERE queue='item.ask'", [status]);
      // Reconstruct the pre-upgrade database from its delivery job alone.
      db.run("DROP TABLE restart_decision");
      db.exec(migration.sql);
      expect(db.query("SELECT * FROM restart_decision").all()).toHaveLength(1);
      expect(requeueOrphanedWork(db, 45 * 60_000)).toEqual([]);
      recoverOnStartup(db, 45 * 60_000);
      expect(getWorkItem(db, item.id)?.state).toBe("recovering");
      expect(db.query("SELECT queue FROM job WHERE status='pending'").all()).toEqual([
        { queue: "item.ask" },
      ]);
    } finally {
      db.close();
    }
  });
}

test("the corrective migration adopts a verifying item's pending restart delivery", () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db);
    const item = insertQueuedItem(db, { sessionKey: "ses", now: 0 });
    beginImplementRun(db, item.id, 0);
    db.run("UPDATE work_item SET state='verifying',recovery_attempts=1,resumed_at=0 WHERE id=?", [
      item.id,
    ]);
    recoverOnStartup(db, 0);
    db.run("DROP TRIGGER restart_decision_lifecycle");
    db.run("DROP TABLE restart_decision");
    db.exec(migration.sql);
    expect(db.query("SELECT * FROM restart_decision").all()).toEqual([]);
    db.exec(correction.sql);
    expect(db.query("SELECT item_id FROM restart_decision").all()).toEqual([{ item_id: item.id }]);
    recoverOnStartup(db, 45 * 60_000);
    expect(db.query("SELECT queue FROM job WHERE status='pending'").all()).toEqual([
      { queue: "item.ask" },
    ]);
    expect(getWorkItem(db, item.id)?.recoveryAttempts).toBe(1);
  } finally {
    db.close();
  }
});
