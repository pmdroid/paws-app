import { afterEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  beginImplementRun,
  enqueueJob,
  insertQueuedItem,
  listRunnerOverview,
  saveItemHolds,
  startUsagePause,
  type Db,
} from "../../../db";
import { JOB_KIND } from "../../../core";
import type { StatusItem } from "../contract";
import { doingTimeLine, issueTimeLine, itemPill, itemTime } from "../client/doing";
import { createLiveStatusProvider } from "./provider";
import { STALL_MS } from "./doing";
import { seed, withoutForeignKeys } from "../../../../test/dialects";
import { tempStore } from "../../../../test/pglite";

const MINUTE = 60_000;
const START = Date.parse("2026-11-01T14:00:00.000Z");
const open: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function database() {
  const { db, close } = await tempStore();
  open.push(close);
  await withoutForeignKeys(db);
  await seed(
    db,
    (q) =>
      q.orm.insert(q.t.runner).values(
        ["agentbox", "spare"].map((name) => ({
          id: name,
          workspaceId: "workspace",
          ownerUserId: "owner",
          name,
          status: "active",
          createdAt: 0,
          lastSeenAt: START,
        })),
      ),
    (q) => q.orm.insert(q.t.runnerCapacity).values({ runnerId: "agentbox", capacity: 2 }),
  );
  return db;
}

async function running(db: Db, id: string): Promise<string> {
  await insertQueuedItem(db, { id, title: id, now: START });
  const runId = (await beginImplementRun(db, id, START)).run.id;
  await seed(db, (q) =>
    q.orm.update(q.t.workItemEvent).set({ at: START }).where(eq(q.t.workItemEvent.itemId, id)),
  );
  return runId;
}

function work(db: Db, runId: string, runner: string, live: boolean, now: number, generation = 1) {
  return seed(db, (q) =>
    q.orm.insert(q.t.runnerWork).values({
      runId,
      runnerId: runner,
      workspaceId: "workspace",
      generation,
      runnerFence: 0,
      commandId: `command-${runId}`,
      leaseUntil: now + 10 * MINUTE,
      endedAt: live ? null : now - MINUTE,
    }),
  );
}

function event(db: Db, runId: string, generation: number, type: string) {
  return seed(db, (q) =>
    q.orm.insert(q.t.runnerEvent).values({
      runId,
      generation,
      sequence: sql`(SELECT COUNT(*) + 1 FROM runner_event WHERE run_id = ${runId} AND generation = ${generation})`,
      payload: {},
      receivedAt: START,
      type,
    }),
  );
}

async function item(db: Db, id: string, now: number): Promise<StatusItem> {
  const found = (
    await createLiveStatusProvider(db, { now: () => new Date(now) }).issues()
  ).issues.find((entry) => entry.title === id);

  if (!found) throw new Error(`no item ${id}`);
  return found;
}

describe("what an item does now", () => {
  test("an item with live runner work shows Running on its runner", async () => {
    const db = await database();
    const now = START + 5 * MINUTE;
    const runId = await running(db, "live");
    await work(db, runId, "agentbox", true, now);
    await event(db, runId, 1, "activity");
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
    const db = await database();
    const now = START + 5 * MINUTE;
    const runId = await running(db, "setup");
    await work(db, runId, "agentbox", true, now, 2);
    await event(db, runId, 1, "activity");
    await event(db, runId, 2, "progress");
    await event(db, runId, 2, "progress");
    const preparing = await item(db, "setup", now);
    expect(preparing.doing).toMatchObject({ kind: "running", phase: "preparing" });
    expect(itemTime(preparing, now)).toContain(
      "Preparing: checking out and installing runtimes on agentbox",
    );
    await event(db, runId, 2, "activity");
    const agent = await item(db, "setup", now);
    expect(agent.doing).toMatchObject({ kind: "running", phase: "agent" });
    expect(itemTime(agent, now)).toContain("Running on agentbox");
  });

  test("a run without runner work has no phase", async () => {
    const db = await database();
    const now = START + MINUTE;
    await running(db, "local");
    expect((await item(db, "local", now)).doing?.phase).toBeUndefined();
  });

  test("an item parked in a slot wait shows Waiting for a slot with its runners and wait time", async () => {
    const db = await database();
    const now = START + 26 * MINUTE;
    await insertQueuedItem(db, { id: "parked", title: "parked", now: START });
    await seed(db, (q) =>
      q.orm
        .update(q.t.workItem)
        .set({ awakeMs: 114 * MINUTE })
        .where(eq(q.t.workItem.id, "parked")),
    );
    await enqueueJob(db, {
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
    const db = await database();
    const now = START + MINUTE;
    await running(db, "staged");
    await seed(db, (q) =>
      q.orm
        .update(q.t.workItem)
        .set({
          implementMs: 130 * MINUTE,
          fixMs: 65 * MINUTE,
          closeoutMs: 22 * MINUTE,
          maxAwakeMs: 180 * MINUTE,
          maxFixMs: 0,
          maxCloseoutMs: 0,
        })
        .where(eq(q.t.workItem.id, "staged")),
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
    const db = await database();
    const runId = await running(db, "paused");
    await startUsagePause(db, {
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
    const db = await database();
    const now = START + 10 * MINUTE;
    await work(db, await running(db, "one"), "agentbox", true, now);
    await work(db, await running(db, "two"), "agentbox", true, now);
    await work(db, await running(db, "pinned"), "agentbox", false, now);
    await saveItemHolds(db, [{ itemId: "pinned", reason: "slot", blockers: [] }]);
    const shown = await item(db, "pinned", now);
    expect(shown.state).toBe("running");
    expect(shown.doing).toMatchObject({ kind: "slot", runners: ["agentbox"] });
    expect(itemTime(shown, now)).toContain("Waiting for a slot on agentbox");
    const agentbox = (await listRunnerOverview(db, "workspace", now)).find(
      (r) => r.id === "agentbox",
    )!;
    const pinned = agentbox.running.find((session) => session.title === "pinned")!;
    expect(pinned.movable).toBe(false);
    expect(agentbox.running.filter((session) => session.movable)).toHaveLength(2);
  });

  test("an item with no live work and no transition for 30 minutes shows Stalled", async () => {
    const db = await database();
    await running(db, "stuck");
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
    const db = await database();
    const now = START + 10 * MINUTE;
    for (const id of ["a", "b"]) await work(db, await running(db, id), "agentbox", true, now);
    for (const id of ["c", "d"]) await work(db, await running(db, id), "agentbox", false, now);
    const agentbox = (await listRunnerOverview(db, "workspace", now)).find(
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
