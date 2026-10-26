import { expect, test } from "bun:test";
import { WORK_ITEM_STATES } from "../src/core";
import { beginImplementRun, insertQueuedItem, migrate, openDatabase } from "../src/db";

const PREVIOUS = "147_job_item_version_and_question_reason";

test("removing obsolete states preserves work items, references, indexes and setup triggers", () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db, { until: PREVIOUS });
    insertQueuedItem(db, { id: "spent" });
    const { run } = beginImplementRun(db, "spent", 100);
    db.run(`UPDATE work_item SET state='exhausted', task_key='task', accepted_head='head',
      linear_project_id='project', agent_ms=123, checkpoint='{"phase":"verifying"}' WHERE id='spent'`);
    insertQueuedItem(db, { id: "held" });
    db.run("INSERT INTO runner_setup_hold(item_id,reason,since) VALUES('held','no-runner',10)");
    db.run("INSERT INTO runner_setup_resume(item_id,run_id,released_at) VALUES('held',?,20)", [
      run.id,
    ]);
    const before = db
      .query<{ state: string; [key: string]: unknown }, []>("SELECT * FROM work_item ORDER BY id")
      .all();
    const references = db.query("SELECT * FROM run").all();
    const events = db.query("SELECT * FROM work_item_event").all();
    const schema = db
      .query(
        "SELECT type,name,sql FROM sqlite_master WHERE tbl_name='work_item' AND type<>'table' ORDER BY name",
      )
      .all();
    migrate(db);
    migrate(db);
    expect(db.query("SELECT * FROM work_item ORDER BY id").all()).toEqual(
      before.map((row) => ({ ...row, state: row.state === "exhausted" ? "failed" : row.state })),
    );
    expect(db.query("SELECT * FROM run").all()).toEqual(references);
    expect(db.query("SELECT * FROM work_item_event").all()).toEqual(events);
    expect(
      db
        .query(
          "SELECT type,name,sql FROM sqlite_master WHERE tbl_name='work_item' AND type<>'table' ORDER BY name",
        )
        .all(),
    ).toEqual(schema);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.query("SELECT * FROM runner_setup_hold").all()).toHaveLength(1);
    expect(db.query("SELECT * FROM runner_setup_resume").all()).toHaveLength(1);
    for (const state of WORK_ITEM_STATES)
      db.run("UPDATE work_item SET state=? WHERE id='spent'", [state]);
    for (const state of ["exhausted", "awaiting_signoff"])
      expect(() => db.run("UPDATE work_item SET state=? WHERE id='spent'", [state])).toThrow(
        "CHECK",
      );
    db.run("UPDATE work_item SET state='running' WHERE id='spent'");
    expect(() =>
      db.run("UPDATE work_item SET linear_issue_id='lin-item-held' WHERE id='spent'"),
    ).toThrow("UNIQUE");
    db.run("UPDATE work_item SET state='running' WHERE id='held'");
    expect(db.query("SELECT * FROM runner_setup_hold").all()).toEqual([]);
    db.run("UPDATE work_item SET cancel_requested=1 WHERE id='held'");
    expect(db.query("SELECT * FROM runner_setup_resume").all()).toEqual([]);
  } finally {
    db.close();
  }
});

test("an unexpected signoff row stops migration without losing data", () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db, { until: PREVIOUS });
    insertQueuedItem(db, { id: "unexpected" });
    db.run("UPDATE work_item SET state='awaiting_signoff' WHERE id='unexpected'");
    expect(() => migrate(db)).toThrow("unexpectedly awaiting sign-off");
    expect(db.query("SELECT state FROM work_item").get()).toEqual({ state: "awaiting_signoff" });
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});
