import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  applyWorkItemEvent,
  beginImplementRun,
  enterMergeQueue,
  insertQueuedItem,
  type Db,
} from "../../../db";
import { parseIssueDetailResponse, parseIssueListResponse } from "../contract";
import { createLiveStatusProvider, STATUS_RECENT_LIMIT, STATUS_RECENT_MS } from "./provider";
import { seed } from "../../../../test/dialects";
import { tempStore } from "../../../../test/pglite";

const NOW = 1_700_000_000_000;

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function database() {
  const { db, close } = await tempStore();
  open.push(close);
  return db;
}

async function finish(db: Db, id: string, at: number): Promise<void> {
  await insertQueuedItem(db, { id, title: id, now: at - 1_000 });
  await applyWorkItemEvent(db, id, "cancel", { now: at });
}

function provider(db: Db, sessionIds?: readonly string[]) {
  return createLiveStatusProvider(db, {
    now: () => new Date(NOW),
    env: {},
    ...(sessionIds === undefined ? {} : { sessionIds }),
  });
}

describe("issue resources", () => {
  test("the list keeps every open issue and the 50 latest finished in a day; older issues open directly", async () => {
    const db = await database();
    await insertQueuedItem(db, { id: "ENG-OPEN", title: "Open", now: NOW - 7 * STATUS_RECENT_MS });
    await finish(db, "ENG-OLD", NOW - STATUS_RECENT_MS - 60_000);
    for (let index = 0; index < STATUS_RECENT_LIMIT + 5; index += 1)
      await finish(db, `ENG-${100 + index}`, NOW - 120_000 - index * 1_000);
    const live = provider(db);
    const parsed = parseIssueListResponse(JSON.parse(JSON.stringify(await live.issues())));
    if (!parsed.ok) throw new Error(parsed.error);
    const ids = parsed.response.issues.map((issue) => issue.id);
    expect(ids).toContain("ENG-OPEN");
    expect(ids.filter((id) => id !== "ENG-OPEN")).toHaveLength(STATUS_RECENT_LIMIT);
    expect(ids).toContain("ENG-100");
    expect(ids).not.toContain(`ENG-${100 + STATUS_RECENT_LIMIT + 4}`);
    expect(ids).not.toContain("ENG-OLD");
    expect((await live.issue("ENG-OLD"))?.issue).toMatchObject({ id: "ENG-OLD", state: "stopped" });
  });

  test("the list carries the snapshot's issue rows, runs and summaries and nothing else", async () => {
    const db = await database();
    await insertQueuedItem(db, {
      id: "ENG-1",
      title: "Running",
      sessionKey: "s1",
      now: NOW - 9_000,
    });
    await beginImplementRun(db, "ENG-1", NOW - 8_000);
    await insertQueuedItem(db, {
      id: "ENG-2",
      title: "Merging",
      sessionKey: "s1",
      now: NOW - 7_000,
    });
    await beginImplementRun(db, "ENG-2", NOW - 6_000);
    await enterMergeQueue(db, "ENG-2", {
      phase: "merge_queue",
      baseSha: "b".repeat(40),
      wipCommit: "c".repeat(40),
    });
    await finish(db, "ENG-3", NOW - 5_000);
    const live = provider(db);
    const list = await live.issues();
    expect(Object.keys(list).sort()).toEqual([
      "agentCloseout",
      "generatedAt",
      "issues",
      "mergedTimes",
      "project",
      "runs",
      "source",
      "verdicts",
    ]);
    expect(list.issues.find((issue) => issue.id === "ENG-1")?.doing).toBeDefined();
  });

  test("the detail names the current session and keeps the earlier one with when it ended", async () => {
    const db = await database();
    const identify = (id: string) =>
      seed(db, (q) =>
        q.orm
          .update(q.t.workItem)
          .set({ linearIdentifier: "PAS-367", linearIssueId: "lin" })
          .where(eq(q.t.workItem.id, id)),
      );
    await insertQueuedItem(db, { id: "OLD", title: "Keep runs", sessionKey: "earlier", now: 0 });
    await identify("OLD");
    await beginImplementRun(db, "OLD", NOW - 7_200_000);
    await seed(
      db,
      (q) => q.orm.update(q.t.workItem).set({ state: "cancelled" }).where(eq(q.t.workItem.id, "OLD")),
      (q) =>
        q.orm
          .update(q.t.run)
          .set({ status: "ended", updatedAt: NOW - 3_600_000 })
          .where(eq(q.t.run.itemId, "OLD")),
    );
    await insertQueuedItem(db, {
      id: "NEW",
      title: "Keep runs",
      sessionKey: "current",
      now: NOW - 1,
    });
    await identify("NEW");
    const live = provider(db);
    const parsed = parseIssueDetailResponse(
      JSON.parse(JSON.stringify(await live.issue("PAS-367"))),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const detail = parsed.response;
    expect(detail.issue.session?.id).toBe("current");
    expect(detail.issue.endedAt).toBeUndefined();
    expect(detail.earlierSessions.map((session) => [session.session?.id, session.endedAt])).toEqual(
      [["earlier", new Date(NOW - 3_600_000).toISOString()]],
    );
    expect(detail.blocks).toEqual([]);
  });
});
