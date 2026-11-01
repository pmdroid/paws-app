import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  beginImplementRun,
  enqueueJob,
  insertQueuedItem,
  listRunnerOverview,
  migrate,
  openDatabase,
  saveItemHolds,
  startUsagePause,
} from "../../../db";
import { JOB_KIND } from "../../../core";
import type { StatusItem } from "../contract";
import { doingTimeLine, itemPill } from "../client/doing";
import { createLiveStatusProvider } from "./provider";
import { STALL_MS } from "./doing";

const MINUTE = 60_000;
const START = Date.parse("2026-11-01T14:00:00.000Z");
const open: Database[] = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function database(): Database {
  const db = openDatabase(":memory:");
  migrate(db);
  db.run("PRAGMA foreign_keys=OFF");
  open.push(db);
  for (const name of ["agentbox", "spare"])
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,'workspace','owner',?,'active',0,?)",
      [name, name, START],
    );
  db.run("INSERT INTO runner_capacity(runner_id,capacity) VALUES('agentbox',2)");
  return db;
}

function running(db: Database, id: string): string {
  insertQueuedItem(db, { id, title: id, now: START });
  const runId = beginImplementRun(db, id, START).run.id;
  db.run("UPDATE work_item_event SET at=? WHERE item_id=?", [START, id]);
  return runId;
}

function work(db: Database, runId: string, runner: string, live: boolean, now: number): void {
  db.run(
    "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,ended_at) VALUES(?,?,'workspace',1,0,?,?,?)",
    [runId, runner, `command-${runId}`, now + 10 * MINUTE, live ? null : now - MINUTE],
  );
}

function item(db: Database, id: string, now: number): StatusItem {
  const found = createLiveStatusProvider(db, { now: () => new Date(now) })
    .snapshot()
    .items.find((entry) => entry.title === id);
  if (!found) throw new Error(`no item ${id}`);
  return found;
}

describe("what an item does now", () => {
  test("an item with live runner work shows Running on its runner", () => {
    const db = database();
    const now = START + 5 * MINUTE;
    work(db, running(db, "live"), "agentbox", true, now);
    const shown = item(db, "live", now);
    expect(shown.doing).toEqual({ kind: "running", runners: ["agentbox"], since: null });
    expect(itemPill(shown)).toContain("Running on agentbox");
  });

  test("an item parked in a slot wait shows Waiting for a slot with its runners and wait time", () => {
    const db = database();
    const now = START + 26 * MINUTE;
    insertQueuedItem(db, { id: "parked", title: "parked", now: START });
    db.run("UPDATE work_item SET awake_ms=? WHERE id='parked'", [114 * MINUTE]);
    enqueueJob(db, {
      queue: JOB_KIND.resume,
      payload: {
        itemId: "parked",
        capacityWait: { since: START, attempt: 2, runnerIds: ["agentbox", "spare"] },
      },
      runAt: now + MINUTE,
      now: START,
    });
    const shown = item(db, "parked", now);
    expect(shown.doing).toMatchObject({ kind: "slot", runners: ["agentbox", "spare"] });
    expect(itemPill(shown)).toContain("Waiting for a slot on agentbox, spare");
    expect(doingTimeLine(shown, now)).toBe("1.9 h active · waiting 26 min");
  });

  test("an item with a usage pause shows Paused with the reset time", () => {
    const db = database();
    const runId = running(db, "paused");
    startUsagePause(db, {
      runId,
      itemId: "paused",
      agent: "claude",
      runnerId: "agentbox",
      resetsAt: START + 60 * MINUTE,
      resumeAt: START + 60 * MINUTE,
      pausedAt: START + MINUTE,
    });
    const shown = item(db, "paused", START + 2 * MINUTE);
    expect(shown.doing).toMatchObject({ kind: "paused", until: "2026-11-01T15:00:00.000Z" });
    expect(itemPill(shown)).toContain("Paused: claude usage limit until 15:00 UTC");
  });

  test("a running item whose pinned run waits for its busy runner shows Waiting, not Running", () => {
    const db = database();
    const now = START + 10 * MINUTE;
    work(db, running(db, "one"), "agentbox", true, now);
    work(db, running(db, "two"), "agentbox", true, now);
    work(db, running(db, "pinned"), "agentbox", false, now);
    saveItemHolds(db, [{ itemId: "pinned", reason: "slot", blockers: [] }]);
    const shown = item(db, "pinned", now);
    expect(shown.state).toBe("running");
    expect(shown.doing).toMatchObject({ kind: "slot", runners: ["agentbox"] });
    expect(itemPill(shown)).toContain("Waiting for a slot on agentbox");
    const agentbox = listRunnerOverview(db, "workspace", now).find((r) => r.id === "agentbox")!;
    const pinned = agentbox.running.find((session) => session.title === "pinned")!;
    expect(pinned.movable).toBe(false);
    expect(agentbox.running.filter((session) => session.movable)).toHaveLength(2);
  });

  test("an item with no live work and no transition for 30 minutes shows Stalled", () => {
    const db = database();
    running(db, "stuck");
    const fresh = item(db, "stuck", START + STALL_MS - MINUTE);
    expect(fresh.doing).toMatchObject({ kind: "idle" });
    expect(fresh.doing?.stalled).toBeUndefined();
    const stale = item(db, "stuck", START + STALL_MS);
    expect(stale.doing).toMatchObject({ kind: "idle", stalled: true });
    expect(itemPill(stale)).toContain("Stalled");
  });
});

describe("runner slots", () => {
  test("live commands and holds between commands stay apart in the runner overview", () => {
    const db = database();
    const now = START + 10 * MINUTE;
    for (const id of ["a", "b"]) work(db, running(db, id), "agentbox", true, now);
    for (const id of ["c", "d"]) work(db, running(db, id), "agentbox", false, now);
    const agentbox = listRunnerOverview(db, "workspace", now).find((r) => r.id === "agentbox")!;
    expect(agentbox.slots).toEqual({ used: 4, total: 2 });
    expect(agentbox.running.map((session) => [session.title, session.movable]).sort()).toEqual([
      ["a", true],
      ["b", true],
      ["c", false],
      ["d", false],
    ]);
  });
});
