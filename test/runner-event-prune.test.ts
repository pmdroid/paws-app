import { expect, test } from "bun:test";
import { migrate, openDatabase, sqliteDb } from "../src/db";
import { pruneRunnerEvents } from "../src/runner-work";

const DAY = 86_400_000;
const NOW = 100 * DAY;

function setup() {
  const db = openDatabase(":memory:");
  migrate(db);
  db.run("PRAGMA foreign_keys=OFF");
  const run = (
    id: string,
    endedDaysAgo: number,
    events: number,
    options: { status?: string; workEnded?: boolean } = {},
  ) => {
    db.run(
      "INSERT INTO run(id,item_id,kind,agent,status,created_at,updated_at) VALUES(?,'item','agent','codex',?,0,?)",
      [id, options.status ?? "ended", NOW - endedDaysAgo * DAY],
    );
    db.run(
      "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,ended_at) VALUES(?,'runner','workspace',1,0,?,0,?)",
      [id, `command-${id}`, options.workEnded === false ? null : 0],
    );
    const insert = db.query(
      "INSERT INTO runner_event(run_id,generation,sequence,payload,received_at,key_id,type) VALUES(?,1,?,'\"sealed\"',0,'key',?)",
    );
    db.transaction(() => {
      for (let sequence = 1; sequence <= events; sequence++) insert.run(id, sequence, "progress");
    })();
  };
  const item = (id: string, state: string, runId: string) =>
    db.run(
      "INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,current_run_id) VALUES(?,'d',?,?,'t',?,?,0,0,?)",
      [id, id, id, state, `paws/${id}`, runId],
    );
  const count = (runId: string) =>
    db
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM runner_event WHERE run_id=?")
      .get(runId)!.n;
  return { db, run, item, count };
}

test("the prune deletes events of runs that ended over a week ago and keeps the rest", async () => {
  const { db, run, item, count } = setup();
  run("old", 8, 3);
  run("lost", 30, 2, { status: "lost" });
  run("recent", 6, 3);
  run("active", 30, 2, { status: "active" });
  run("current", 30, 2);
  item("open", "awaiting_input", "current");
  run("finished", 30, 2);
  item("done", "merged", "finished");
  run("open-work", 30, 2, { workEnded: false });
  run("asked", 30, 3);
  db.run("UPDATE runner_event SET type='question' WHERE run_id='asked' AND sequence=2");
  run("answered", 30, 3);
  db.run("UPDATE runner_event SET type='question' WHERE run_id='answered' AND sequence=2");
  db.run("INSERT INTO runner_question_answer VALUES('answered',1,2,'yes',0)");

  expect(await pruneRunnerEvents({ store: sqliteDb(db), now: NOW })).toEqual({ deleted: 9 });
  expect(count("old")).toBe(0);
  expect(count("lost")).toBe(0);
  expect(count("finished")).toBe(0);
  expect(count("recent")).toBe(3);
  expect(count("active")).toBe(2);
  expect(count("current")).toBe(2);
  expect(count("open-work")).toBe(2);
  expect(count("asked")).toBe(3);
  expect(count("answered")).toBe(1);
  expect(db.query("SELECT count(*) AS n FROM run").get()).toEqual({ n: 9 });

  expect(await pruneRunnerEvents({ store: sqliteDb(db), now: NOW })).toEqual({ deleted: 0 });
});

test("the prune deletes at most 5,000 events per transaction", async () => {
  const { db, run, count } = setup();
  run("big", 8, 12_001);
  const batches: number[] = [];
  expect(
    await pruneRunnerEvents({
      store: sqliteDb(db),
      now: NOW,
      onBatch: (deleted) => batches.push(deleted),
    }),
  ).toEqual({ deleted: 12_001 });
  expect(batches).toEqual([5_000, 5_000, 2_001]);
  expect(count("big")).toBe(0);
});
