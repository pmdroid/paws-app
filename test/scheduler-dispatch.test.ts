import { confirmFakeMerge } from "./fake-workspace";
import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  beginImplementRun,
  ensureLinearSession,
  getWorkItem,
  insertQueuedItem,
  sqliteDb,
  type Db,
} from "../src/db";
import { Orchestrator } from "../src/loop";
import * as scheduler from "../src/scheduler";
import type { SchedulerOptions } from "../src/scheduler";
import { tempDb } from "./helpers";
import { workspaceDispatch } from "./fake-workspace";

function sameDelegation(db: ReturnType<typeof tempDb>, ids: readonly string[]): void {
  for (const id of ids) db.run("UPDATE work_item SET delegation_id='shared' WHERE id=?", [id]);
}

test("dispatch asks readiness itself instead of trusting a handed-in ready list", async () => {
  const db = tempDb();
  try {
    await insertQueuedItem(db, { id: "blocker", now: 1 });
    await insertQueuedItem(db, { id: "blocked", now: 2 });
    sameDelegation(db, ["blocker", "blocked"]);
    db.run(
      "INSERT INTO task_block(blocker_linear_issue_id,blocked_linear_issue_id) VALUES('lin-item-blocker','lin-item-blocked')",
    );
    expect(await workspaceDispatch(db, { now: 1000 })).toEqual(["blocker"]);
    await confirmFakeMerge(db, "blocker");
    db.run("UPDATE work_item SET state='merged' WHERE id='blocker'");
    expect(await workspaceDispatch(db, { now: 1001 })).toEqual(["blocked"]);
  } finally {
    db.close();
  }
});

test("dispatch admits ready Items while another one is in flight", async () => {
  const db = tempDb();
  try {
    await insertQueuedItem(db, { id: "first", now: 1 });
    expect(await workspaceDispatch(db, { now: 1000 })).toEqual(["first"]);
    db.run("UPDATE work_item SET state='running' WHERE id='first'");
    db.run("UPDATE job SET status='done' WHERE json_extract(payload,'$.itemId')='first'");
    await insertQueuedItem(db, { id: "second", now: 2 });
    await insertQueuedItem(db, { id: "third", now: 3 });
    expect(await workspaceDispatch(db, { now: 1001 })).toEqual(["second", "third"]);
  } finally {
    db.close();
  }
});

test("the orchestrator dispatches after the transition's transaction has resolved", async () => {
  const db = tempDb();
  const root = await mkdtemp(join(tmpdir(), "paws-dispatch-"));
  const sqlite = sqliteDb(db);
  let open = 0;
  const store = {
    ...sqlite,
    transaction: async (body) => {
      open++;
      try {
        return await sqlite.transaction(body);
      } finally {
        open--;
      }
    },
  } as Db;
  const seen: { open: number; state: string | undefined }[] = [];
  const spy = spyOn(scheduler, "dispatch").mockImplementation(async () => {
    seen.push({ open, state: (await getWorkItem(sqlite, "item"))?.state });
    return [];
  });
  try {
    const clock = new FakeClock(1_000);
    const orchestrator = new Orchestrator({
      store,
      clock,
      jobs: new JobLoop(db, clock),
      outbox: new OutboxDispatcher(db, clock),
      pawsRoot: root,
    });
    await insertQueuedItem(db, { id: "item", now: 1 });
    await beginImplementRun(sqlite, "item", clock.now());
    const item = (await getWorkItem(sqlite, "item"))!;
    await orchestrator["fail"](item, "broken", "The run broke.");
    expect(seen).toEqual([{ open: 0, state: "failed" }]);
  } finally {
    spy.mockRestore();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("dispatch yields an idle merge session to a ready sibling", async () => {
  const db = tempDb();
  try {
    await insertQueuedItem(db, { id: "merging", now: 1, sessionKey: "session" });
    await insertQueuedItem(db, { id: "next", now: 2, sessionKey: "session" });
    sameDelegation(db, ["merging", "next"]);
    db.run("UPDATE work_item SET state='merge_queue' WHERE id='merging'");
    await ensureLinearSession(sqliteDb(db), {
      sessionId: "session",
      issueId: "lin-item-merging",
      now: 1,
    });
    db.run("UPDATE linear_session SET active_item_id='merging' WHERE session_id='session'");
    await workspaceDispatch(db, { now: 1000 });
    expect(
      db
        .query<{ active: string | null }, []>(
          "SELECT active_item_id AS active FROM linear_session WHERE session_id='session'",
        )
        .get()?.active,
    ).toBeNull();
  } finally {
    db.close();
  }
});

test("dispatch reports the ready items it left waiting", async () => {
  const db = tempDb();
  try {
    await insertQueuedItem(db, { id: "first", now: 1 });
    await insertQueuedItem(db, { id: "second", now: 2 });
    const waiting: string[] = [];
    const options: SchedulerOptions & { onWaiting: (ids: readonly string[]) => void } = {
      now: 1000,
      ownerCap: 1,
      onWaiting: (ids) => waiting.push(...ids),
    };
    expect(await workspaceDispatch(db, options)).toEqual(["first"]);
    expect(waiting).toEqual(["second"]);
  } finally {
    db.close();
  }
});
