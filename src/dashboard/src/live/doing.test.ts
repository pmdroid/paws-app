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
  sqliteDb,
} from "../../../db";
import { JOB_KIND } from "../../../core";
import type { StatusItem } from "../contract";
import { doingTimeLine, issueTimeLine, itemPill, itemTime } from "../client/doing";
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

function work(
  db: Database,
  runId: string,
  runner: string,
  live: boolean,
  now: number,
  generation = 1,
): void {
  db.run(
    "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,ended_at) VALUES(?,?,'workspace',?,0,?,?,?)",
    [runId, runner, generation, `command-${runId}`, now + 10 * MINUTE, live ? null : now - MINUTE],
  );
}

function event(db: Database, runId: string, generation: number, type: string): void {
  db.run(
    "INSERT INTO runner_event(run_id,generation,sequence,payload,received_at,type) VALUES(?,?,(SELECT COUNT(*)+1 FROM runner_event WHERE run_id=?1 AND generation=?2),'{}',?,?)",
    [runId, generation, START, type],
  );
}

async function item(db: Database, id: string, now: number): Promise<StatusItem> {
  const found = (
    await createLiveStatusProvider(db, { now: () => new Date(now) }).issues()
  ).issues.find((entry) => entry.title === id);

  if (!found) throw new Error(`no item ${id}`);
  return found;
}

describe("what an item does now", () => {
  test("an item with live runner work shows Running on its runner", async () => {
    const db = database();
    const now = START + 5 * MINUTE;
    const runId = running(db, "live");
    work(db, runId, "agentbox", true, now);
    event(db, runId, 1, "activity");
    const shown = await item(db, "live", now);
    expect(shown.doing).toEqual({
      kind: "running",
      runners: ["agentbox"],
      since: null,
      phase: "agent",
    });
    expect(itemPill(shown)).toContain(">Running<");
    expect(itemTime(shown, now)).toContain("Running on agentbox");
  });

  test("live runner work is preparing until its current generation reports agent activity", async () => {
    const db = database();
    const now = START + 5 * MINUTE;
    const runId = running(db, "setup");
    work(db, runId, "agentbox", true, now, 2);
    event(db, runId, 1, "activity");
    event(db, runId, 2, "progress");
    event(db, runId, 2, "progress");
    const preparing = await item(db, "setup", now);
    expect(preparing.doing).toMatchObject({ kind: "running", phase: "preparing" });
    expect(itemTime(preparing, now)).toContain(
      "Preparing: checking out and installing runtimes on agentbox",
    );
    event(db, runId, 2, "activity");
    const agent = await item(db, "setup", now);
    expect(agent.doing).toMatchObject({ kind: "running", phase: "agent" });
    expect(itemTime(agent, now)).toContain("Running on agentbox");
  });

  test("a run without runner work has no phase", async () => {
    const db = database();
    const now = START + MINUTE;
    running(db, "local");
    expect((await item(db, "local", now)).doing?.phase).toBeUndefined();
  });

  test("an item parked in a slot wait shows Waiting for a slot with its runners and wait time", async () => {
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
    const shown = await item(db, "parked", now);
    expect(shown.doing).toMatchObject({ kind: "slot", runners: ["agentbox", "spare"] });
    expect(itemPill(shown)).toContain(">Waiting for a slot<");
    expect(itemTime(shown, now)).toContain("Waiting for a slot on agentbox, spare · 1.9 h active");
    expect(doingTimeLine(shown, now)).toBe("1.9 h active · waiting 26 min");
  });

  test("the issue page splits the item's time by stage and marks stages that are not counted", async () => {
    const db = database();
    const now = START + MINUTE;
    running(db, "staged");
    db.run(
      "UPDATE work_item SET implement_ms=?, fix_ms=?, closeout_ms=?, max_awake_ms=?, max_fix_ms=0, max_closeout_ms=0 WHERE id='staged'",
      [130 * MINUTE, 65 * MINUTE, 22 * MINUTE, 180 * MINUTE],
    );
    const shown = await item(db, "staged", now);
    expect(shown.stageTimes).toEqual({
      implementation: { ms: 130 * MINUTE, limitMs: 180 * MINUTE },
      fixes: { ms: 65 * MINUTE, limitMs: 0 },
      closeout: { ms: 22 * MINUTE, limitMs: 0 },
    });
    expect(issueTimeLine(shown, now)).toBe(
      "Implementation 2 h 10 m of 3 h · Fixes 1 h 05 m (not counted) · Closeout 22 m (not counted) · waiting 1 min",
    );
  });

  test("an item with a usage pause shows Paused with the reset time", async () => {
    const db = database();
    const runId = running(db, "paused");
    await startUsagePause(sqliteDb(db), {
      runId,
      itemId: "paused",
      agent: "claude",
      runnerId: "agentbox",
      resetsAt: START + 60 * MINUTE,
      resumeAt: START + 60 * MINUTE,
      pausedAt: START + MINUTE,
    });
    const shown = await item(db, "paused", START + 2 * MINUTE);
    expect(shown.doing).toMatchObject({ kind: "paused", until: "2026-11-01T15:00:00.000Z" });
    expect(itemPill(shown)).toContain(">Usage limit<");
    expect(itemTime(shown, START + 2 * MINUTE)).toContain(
      "Paused: claude usage limit until 15:00 UTC",
    );
  });

  test("a running item whose pinned run waits for its busy runner shows Waiting, not Running", async () => {
    const db = database();
    const now = START + 10 * MINUTE;
    work(db, running(db, "one"), "agentbox", true, now);
    work(db, running(db, "two"), "agentbox", true, now);
    work(db, running(db, "pinned"), "agentbox", false, now);
    await saveItemHolds(sqliteDb(db), [{ itemId: "pinned", reason: "slot", blockers: [] }]);
    const shown = await item(db, "pinned", now);
    expect(shown.state).toBe("running");
    expect(shown.doing).toMatchObject({ kind: "slot", runners: ["agentbox"] });
    expect(itemTime(shown, now)).toContain("Waiting for a slot on agentbox");
    const agentbox = (await listRunnerOverview(sqliteDb(db), "workspace", now)).find(
      (r) => r.id === "agentbox",
    )!;
    const pinned = agentbox.running.find((session) => session.title === "pinned")!;
    expect(pinned.movable).toBe(false);
    expect(agentbox.running.filter((session) => session.movable)).toHaveLength(2);
  });

  test("an item with no live work and no transition for 30 minutes shows Stalled", async () => {
    const db = database();
    running(db, "stuck");
    const fresh = await item(db, "stuck", START + STALL_MS - MINUTE);
    expect(fresh.doing).toMatchObject({ kind: "idle" });
    expect(fresh.doing?.stalled).toBeUndefined();
    const stale = await item(db, "stuck", START + STALL_MS);
    expect(stale.doing).toMatchObject({ kind: "idle", stalled: true });
    expect(itemPill(stale)).toContain("Stalled");
  });
});

describe("runner slots", () => {
  test("live commands and holds between commands stay apart in the runner overview", async () => {
    const db = database();
    const now = START + 10 * MINUTE;
    for (const id of ["a", "b"]) work(db, running(db, id), "agentbox", true, now);
    for (const id of ["c", "d"]) work(db, running(db, id), "agentbox", false, now);
    const agentbox = (await listRunnerOverview(sqliteDb(db), "workspace", now)).find(
      (r) => r.id === "agentbox",
    )!;
    expect(agentbox.slots).toEqual({ used: 4, total: 2 });
    expect(agentbox.running.map((session) => [session.title, session.movable]).sort()).toEqual([
      ["a", true],
      ["b", true],
      ["c", false],
      ["d", false],
    ]);
  });
});
