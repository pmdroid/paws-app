import { expect, test } from "bun:test";
import {
  HOT_FILE_WINDOW_MS,
  hotFiles,
  insertQueuedItem,
  listItemHolds,
  listOverlapHoldAges,
  recordConfirmedRemoteMerge,
  recordRebaseReturn,
  saveCandidatePaths,
  type Db,
} from "../src/db";
import { sql, type SQL } from "drizzle-orm";
import { workspaceDispatchPg as workspaceDispatch } from "./fake-workspace";
import { tempStore } from "./pglite";

const NOW = 30 * 24 * 60 * 60 * 1000;
const PROVIDER = "src/dashboard/src/live/provider.ts";

const exec = (db: Db, query: SQL) => db.run((q) => q.exec(q.orm.execute(query)));

async function item(db: Db, id: string, paths: readonly string[] | null, now = 1): Promise<void> {
  await insertQueuedItem(db, { id, now });
  await exec(
    db,
    sql`INSERT INTO work_item_repository(item_id,owner,repo,remote_url) VALUES(${id},'owner','repo','https://github.com/owner/repo.git')`,
  );
  if (paths)
    await saveCandidatePaths(db, {
      itemId: id,
      head: `head-${id}`,
      paths,
      recordedAt: now,
    });
}

/** An earlier item that went back to the agent for a merge-queue conflict in `files`. */
async function conflicted(
  db: Db,
  files: readonly string[] | null,
  at = NOW - 60_000,
): Promise<void> {
  await item(db, "earlier", null);
  await exec(db, sql`UPDATE work_item SET state='merged' WHERE id='earlier'`);
  const returns = await db.run((q) => q.all(q.orm.select().from(q.t.rebaseReturn)));
  await recordRebaseReturn(db, {
    itemId: "earlier",
    jobId: 9000 + returns.length,
    candidate: "head-earlier",
    reason: "merge",
    files,
    recordedAt: at,
  });
}

async function setState(db: Db, id: string, state: string): Promise<void> {
  await exec(db, sql`UPDATE work_item SET state=${state} WHERE id=${id}`);
  await exec(db, sql`UPDATE job SET status='done' WHERE payload->>'itemId'=${id}`);
}

test("two items that change a hot file do not run together; the second starts after the first merges", async () => {
  const { db, close } = await tempStore();
  try {
    await conflicted(db, [PROVIDER]);
    await item(db, "first", [PROVIDER, "src/a.ts"]);
    await item(db, "second", [PROVIDER, "src/b.ts"], 2);
    const log: string[] = [];
    expect(
      await workspaceDispatch(db, { now: NOW, log: (line: string) => log.push(line) }),
    ).toEqual(["first"]);
    expect(await listItemHolds(db)).toEqual([
      { itemId: "second", reason: "overlap", blockers: ["first"], files: [PROVIDER] },
    ]);
    expect(log).toContain("item second held: waiting for first to merge (both change provider.ts)");

    await setState(db, "first", "running");
    expect(await workspaceDispatch(db, { now: NOW + 1 })).toEqual([]);
    await setState(db, "first", "merge_queue");
    expect(await workspaceDispatch(db, { now: NOW + 2 })).toEqual([]);
    expect((await listItemHolds(db)).map((hold) => hold.reason)).toEqual(["overlap"]);

    await setState(db, "first", "merged");
    expect(await workspaceDispatch(db, { now: NOW + 3 })).toEqual(["second"]);
    expect(await listItemHolds(db)).toEqual([]);
  } finally {
    await close();
  }
});

test("items that change different files run in parallel", async () => {
  const { db, close } = await tempStore();
  try {
    await conflicted(db, [PROVIDER]);
    await item(db, "first", [PROVIDER]);
    await item(db, "second", ["src/b.ts"], 2);
    expect(await workspaceDispatch(db, { now: NOW })).toEqual(["first", "second"]);
    expect(await listItemHolds(db)).toEqual([]);
  } finally {
    await close();
  }
});

test("a shared file that is not hot holds nothing", async () => {
  const { db, close } = await tempStore();
  try {
    await conflicted(db, ["src/other.ts"]);
    await item(db, "first", [PROVIDER]);
    await item(db, "second", [PROVIDER], 2);
    expect(await workspaceDispatch(db, { now: NOW })).toEqual(["first", "second"]);
  } finally {
    await close();
  }
});

test("an item with no candidate yet is not held", async () => {
  const { db, close } = await tempStore();
  try {
    await conflicted(db, [PROVIDER]);
    await item(db, "first", [PROVIDER]);
    await setState(db, "first", "running");
    await item(db, "second", null, 2);
    expect(await workspaceDispatch(db, { now: NOW })).toEqual(["second"]);
    expect(await listItemHolds(db)).toEqual([]);
  } finally {
    await close();
  }
});

test("a held item is not counted in the runner line", async () => {
  const { db, close } = await tempStore();
  try {
    await conflicted(db, [PROVIDER]);
    await item(db, "first", [PROVIDER]);
    await setState(db, "first", "running");
    await item(db, "second", [PROVIDER], 2);
    const waiting: string[] = [];
    expect(
      await workspaceDispatch(db, {
        now: NOW,
        onWaiting: (ids: readonly string[]) => waiting.push(...ids),
      }),
    ).toEqual([]);
    expect(waiting).toEqual([]);
  } finally {
    await close();
  }
});

async function blocks(db: Db, blocker: string, blocked: string): Promise<void> {
  await exec(
    db,
    sql`INSERT INTO task_block(blocker_linear_issue_id,blocked_linear_issue_id) VALUES(${`lin-item-${blocker}`},${`lin-item-${blocked}`})`,
  );
}

test("a merge-queue item that depends on the queued item does not hold it", async () => {
  const { db, close } = await tempStore();
  try {
    await conflicted(db, [PROVIDER]);
    await item(db, "dependent", [PROVIDER]);
    await setState(db, "dependent", "merge_queue");
    await item(db, "prerequisite", [PROVIDER], 2);
    await blocks(db, "prerequisite", "dependent");
    expect(await workspaceDispatch(db, { now: NOW })).toEqual(["prerequisite"]);
    expect(await listItemHolds(db)).toEqual([]);
  } finally {
    await close();
  }
});

test("an item that depends on the queued item through another issue does not hold it", async () => {
  const { db, close } = await tempStore();
  try {
    await conflicted(db, [PROVIDER]);
    await item(db, "dependent", [PROVIDER]);
    await setState(db, "dependent", "merge_queue");
    await item(db, "middle", null);
    await setState(db, "middle", "merged");
    await item(db, "prerequisite", [PROVIDER], 2);
    await blocks(db, "prerequisite", "middle");
    await blocks(db, "middle", "dependent");
    expect(await workspaceDispatch(db, { now: NOW })).toEqual(["prerequisite"]);
  } finally {
    await close();
  }
});

test("an item the queued item depends on still holds it", async () => {
  const { db, close } = await tempStore();
  try {
    await conflicted(db, [PROVIDER]);
    await item(db, "prerequisite", [PROVIDER]);
    await setState(db, "prerequisite", "merge_queue");
    await item(db, "dependent", [PROVIDER], 2);
    await blocks(db, "dependent", "unrelated");
    expect(await workspaceDispatch(db, { now: NOW })).toEqual([]);
    expect((await listItemHolds(db)).map((hold) => [hold.itemId, hold.reason])).toEqual([
      ["dependent", "overlap"],
    ]);
  } finally {
    await close();
  }
});

/** A place in the repository's merge queue, kept while the item is back with the agent. */
async function place(db: Db, id: string, readyAt: number): Promise<void> {
  await exec(
    db,
    sql`INSERT INTO merge_queue_entry(item_id,repository,ready_at,kept) VALUES(${id},'owner/repo',${readyAt},1)`,
  );
}

test("a merge-queue item behind the returned front does not hold it", async () => {
  const { db, close } = await tempStore();
  try {
    await conflicted(db, [PROVIDER]);
    await item(db, "follower", [PROVIDER]);
    await setState(db, "follower", "merge_queue");
    await place(db, "follower", 20);
    await item(db, "front", [PROVIDER], 2);
    await place(db, "front", 10);
    expect(await workspaceDispatch(db, { now: NOW })).toEqual(["front"]);
    expect(await listItemHolds(db)).toEqual([]);
  } finally {
    await close();
  }
});

test("a running item does not hold a returned item that keeps its merge-queue place", async () => {
  const { db, close } = await tempStore();
  try {
    await conflicted(db, [PROVIDER]);
    await item(db, "running", [PROVIDER]);
    await setState(db, "running", "running");
    await item(db, "front", [PROVIDER], 2);
    await place(db, "front", 10);
    expect(await workspaceDispatch(db, { now: NOW })).toEqual(["front"]);
  } finally {
    await close();
  }
});

test("a merge-queue item ahead of a returned item still holds it", async () => {
  const { db, close } = await tempStore();
  try {
    await conflicted(db, [PROVIDER]);
    await item(db, "ahead", [PROVIDER]);
    await setState(db, "ahead", "merge_queue");
    await place(db, "ahead", 10);
    await item(db, "returned", [PROVIDER], 2);
    await place(db, "returned", 20);
    expect(await workspaceDispatch(db, { now: NOW })).toEqual([]);
    expect(await listItemHolds(db)).toEqual([
      { itemId: "returned", reason: "overlap", blockers: ["ahead"], files: [PROVIDER] },
    ]);
  } finally {
    await close();
  }
});

test("hot files come from conflict restarts in the last 7 days", async () => {
  const { db, close } = await tempStore();
  try {
    await conflicted(db, ["src/old.ts"], NOW - HOT_FILE_WINDOW_MS - 1);
    expect(await hotFiles(db, NOW)).toEqual([]);
    await exec(db, sql`DELETE FROM work_item_repository`);
    await exec(db, sql`DELETE FROM rebase_return`);
    await exec(db, sql`DELETE FROM work_item`);
    await conflicted(db, [PROVIDER, "src/index.ts"]);
    expect(await hotFiles(db, NOW)).toEqual([
      { repository: "owner/repo", path: PROVIDER, conflicts: 1, items: ["earlier"] },
      { repository: "owner/repo", path: "src/index.ts", conflicts: 1, items: ["earlier"] },
    ]);
  } finally {
    await close();
  }
});

test("a conflict restart without files counts the files a merge before it shared", async () => {
  const { db, close } = await tempStore();
  try {
    await item(db, "merged", [PROVIDER, "src/a.ts"]);
    await recordConfirmedRemoteMerge(db, {
      itemId: "merged",
      repositoryOwner: "owner",
      repositoryName: "repo",
      pullNumber: 1,
      pullUrl: null,
      mergeSha: "merge",
      confirmedAt: NOW - 120_000,
    });
    await item(db, "returned", [PROVIDER, "src/b.ts"]);
    await recordRebaseReturn(db, {
      itemId: "returned",
      jobId: 1,
      candidate: "head-returned",
      reason: "github_queue",
      files: null,
      recordedAt: NOW - 60_000,
    });
    expect(await hotFiles(db, NOW)).toEqual([
      { repository: "owner/repo", path: PROVIDER, conflicts: 1, items: ["returned"] },
    ]);
  } finally {
    await close();
  }
});

test("a later candidate does not change the files of an earlier conflict", async () => {
  const { db, close } = await tempStore();
  try {
    await item(db, "merged", [PROVIDER, "src/a.ts", "src/c.ts"], NOW - 200_000);
    await recordConfirmedRemoteMerge(db, {
      itemId: "merged",
      repositoryOwner: "owner",
      repositoryName: "repo",
      pullNumber: 1,
      pullUrl: null,
      mergeSha: "merge",
      confirmedAt: NOW - 120_000,
    });
    await item(db, "returned", [PROVIDER, "src/b.ts"], NOW - 100_000);
    await recordRebaseReturn(db, {
      itemId: "returned",
      jobId: 1,
      candidate: "head-returned",
      reason: "github_queue",
      files: null,
      recordedAt: NOW - 60_000,
    });
    // The fix drops provider.ts and adds c.ts, which the merge also changed.
    await saveCandidatePaths(db, {
      itemId: "returned",
      head: "head-fixed",
      paths: ["src/b.ts", "src/c.ts"],
      recordedAt: NOW - 30_000,
    });
    // A later candidate of the merged item does not change what it merged.
    await saveCandidatePaths(db, {
      itemId: "merged",
      head: "head-later",
      paths: ["src/b.ts"],
      recordedAt: NOW - 10_000,
    });
    expect((await hotFiles(db, NOW)).map((file) => file.path)).toEqual([PROVIDER]);
  } finally {
    await close();
  }
});

test("held items that change the same hot file start oldest first", async () => {
  const { db, close } = await tempStore();
  try {
    await conflicted(db, [PROVIDER]);
    await item(db, "holder", [PROVIDER]);
    await setState(db, "holder", "running");
    await item(db, "a", [PROVIDER], 3);
    expect(await workspaceDispatch(db, { now: NOW })).toEqual([]);
    await item(db, "b", [PROVIDER], 1);
    await item(db, "c", [PROVIDER], 4);
    expect(await workspaceDispatch(db, { now: NOW + 1 })).toEqual([]);
    expect(await listOverlapHoldAges(db)).toEqual(
      new Map([
        ["a", NOW],
        ["b", NOW + 1],
        ["c", NOW + 1],
      ]),
    );

    await setState(db, "holder", "merged");
    const log: string[] = [];
    expect(
      await workspaceDispatch(db, { now: NOW + 2, log: (line: string) => log.push(line) }),
    ).toEqual(["a"]);
    expect(await listItemHolds(db)).toEqual([
      { itemId: "b", reason: "overlap", blockers: ["a"], files: [PROVIDER] },
      { itemId: "c", reason: "overlap", blockers: ["a"], files: [PROVIDER] },
    ]);
    expect(log).toContain("item b held: waiting for a to start (both change provider.ts)");

    await setState(db, "a", "running");
    expect(await workspaceDispatch(db, { now: NOW + 3 })).toEqual([]);
    expect((await listItemHolds(db)).map((hold) => [hold.itemId, hold.blockers])).toEqual([
      ["b", ["a"]],
      ["c", ["a"]],
    ]);
  } finally {
    await close();
  }
});

test("an item keeps its hold age across a restart from failed and a conflict restart", async () => {
  const { db, close } = await tempStore();
  try {
    await conflicted(db, [PROVIDER]);
    await item(db, "holder", [PROVIDER]);
    await setState(db, "holder", "running");
    await item(db, "a", [PROVIDER], 3);
    expect(await workspaceDispatch(db, { now: NOW })).toEqual([]);
    await setState(db, "holder", "merged");
    expect(await workspaceDispatch(db, { now: NOW + 1 })).toEqual(["a"]);
    await setState(db, "a", "running");
    expect(await workspaceDispatch(db, { now: NOW + 2 })).toEqual([]);
    expect(await listItemHolds(db)).toEqual([]);
    expect((await listOverlapHoldAges(db)).get("a")).toBe(NOW);

    await setState(db, "a", "failed");
    expect(await workspaceDispatch(db, { now: NOW + 3 })).toEqual([]);
    await item(db, "second", [PROVIDER]);
    await setState(db, "second", "running");
    await setState(db, "a", "queued");
    await item(db, "c", [PROVIDER], 1);
    expect(await workspaceDispatch(db, { now: NOW + 4 })).toEqual([]);
    expect((await listOverlapHoldAges(db)).get("a")).toBe(NOW);
    await setState(db, "second", "merged");
    expect(await workspaceDispatch(db, { now: NOW + 5 })).toEqual(["a"]);

    await setState(db, "a", "merge_queue");
    expect(await workspaceDispatch(db, { now: NOW + 6 })).toEqual([]);
    await setState(db, "a", "queued");
    expect(await workspaceDispatch(db, { now: NOW + 7 })).toEqual(["a"]);
    expect(await listItemHolds(db)).toEqual([
      { itemId: "c", reason: "overlap", blockers: ["a"], files: [PROVIDER] },
    ]);
    expect((await listOverlapHoldAges(db)).get("a")).toBe(NOW);

    await setState(db, "a", "merged");
    expect(await workspaceDispatch(db, { now: NOW + 8 })).toEqual(["c"]);
    expect((await listOverlapHoldAges(db)).has("a")).toBe(false);
  } finally {
    await close();
  }
});

test("an item without a candidate is never held, even behind an older held item", async () => {
  const { db, close } = await tempStore();
  try {
    await conflicted(db, [PROVIDER]);
    await item(db, "holder", [PROVIDER]);
    await setState(db, "holder", "running");
    await item(db, "a", [PROVIDER], 3);
    expect(await workspaceDispatch(db, { now: NOW })).toEqual([]);
    await item(db, "unknown", null, 4);
    expect(await workspaceDispatch(db, { now: NOW + 1 })).toEqual(["unknown"]);
    expect((await listItemHolds(db)).map((hold) => hold.itemId)).toEqual(["a"]);
    expect((await listOverlapHoldAges(db)).has("unknown")).toBe(false);
  } finally {
    await close();
  }
});
