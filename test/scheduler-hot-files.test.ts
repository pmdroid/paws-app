import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  HOT_FILE_WINDOW_MS,
  hotFiles,
  insertQueuedItem,
  listItemHolds,
  listOverlapHoldAges,
  recordConfirmedRemoteMerge,
  recordRebaseReturn,
  saveCandidatePaths,
  sqliteDb,
} from "../src/db";
import { tempDb } from "./helpers";
import { workspaceDispatch } from "./fake-workspace";

const NOW = 30 * 24 * 60 * 60 * 1000;
const PROVIDER = "src/dashboard/src/live/provider.ts";

function item(db: Database, id: string, paths: readonly string[] | null, now = 1): void {
  insertQueuedItem(db, { id, now });
  db.run(
    "INSERT INTO work_item_repository(item_id,owner,repo,remote_url) VALUES(?,'owner','repo','https://github.com/owner/repo.git')",
    [id],
  );
  if (paths) saveCandidatePaths(db, { itemId: id, head: `head-${id}`, paths, recordedAt: now });
}

/** An earlier item that went back to the agent for a merge-queue conflict in `files`. */
function conflicted(db: Database, files: readonly string[] | null, at = NOW - 60_000): void {
  item(db, "earlier", null);
  db.run("UPDATE work_item SET state='merged' WHERE id='earlier'");
  recordRebaseReturn(db, {
    itemId: "earlier",
    jobId: 9000 + db.query<{ n: number }, []>("SELECT count(*) AS n FROM rebase_return").get()!.n,
    candidate: "head-earlier",
    reason: "merge",
    files,
    recordedAt: at,
  });
}

function setState(db: Database, id: string, state: string): void {
  db.run("UPDATE work_item SET state=? WHERE id=?", [state, id]);
  db.run("UPDATE job SET status='done' WHERE json_extract(payload,'$.itemId')=?", [id]);
}

test("two items that change a hot file do not run together; the second starts after the first merges", async () => {
  const db = tempDb();
  try {
    conflicted(db, [PROVIDER]);
    item(db, "first", [PROVIDER, "src/a.ts"]);
    item(db, "second", [PROVIDER, "src/b.ts"], 2);
    const log: string[] = [];
    expect(
      await workspaceDispatch(db, { now: NOW, log: (line: string) => log.push(line) }),
    ).toEqual(["first"]);
    expect(await listItemHolds(sqliteDb(db))).toEqual([
      { itemId: "second", reason: "overlap", blockers: ["first"], files: [PROVIDER] },
    ]);
    expect(log).toContain("item second held: waiting for first to merge (both change provider.ts)");

    setState(db, "first", "running");
    expect(await workspaceDispatch(db, { now: NOW + 1 })).toEqual([]);
    setState(db, "first", "merge_queue");
    expect(await workspaceDispatch(db, { now: NOW + 2 })).toEqual([]);
    expect((await listItemHolds(sqliteDb(db))).map((hold) => hold.reason)).toEqual(["overlap"]);

    setState(db, "first", "merged");
    expect(await workspaceDispatch(db, { now: NOW + 3 })).toEqual(["second"]);
    expect(await listItemHolds(sqliteDb(db))).toEqual([]);
  } finally {
    db.close();
  }
});

test("items that change different files run in parallel", async () => {
  const db = tempDb();
  try {
    conflicted(db, [PROVIDER]);
    item(db, "first", [PROVIDER]);
    item(db, "second", ["src/b.ts"], 2);
    expect(await workspaceDispatch(db, { now: NOW })).toEqual(["first", "second"]);
    expect(await listItemHolds(sqliteDb(db))).toEqual([]);
  } finally {
    db.close();
  }
});

test("a shared file that is not hot holds nothing", async () => {
  const db = tempDb();
  try {
    conflicted(db, ["src/other.ts"]);
    item(db, "first", [PROVIDER]);
    item(db, "second", [PROVIDER], 2);
    expect(await workspaceDispatch(db, { now: NOW })).toEqual(["first", "second"]);
  } finally {
    db.close();
  }
});

test("an item with no candidate yet is not held", async () => {
  const db = tempDb();
  try {
    conflicted(db, [PROVIDER]);
    item(db, "first", [PROVIDER]);
    setState(db, "first", "running");
    item(db, "second", null, 2);
    expect(await workspaceDispatch(db, { now: NOW })).toEqual(["second"]);
    expect(await listItemHolds(sqliteDb(db))).toEqual([]);
  } finally {
    db.close();
  }
});

test("a held item is not counted in the runner line", async () => {
  const db = tempDb();
  try {
    conflicted(db, [PROVIDER]);
    item(db, "first", [PROVIDER]);
    setState(db, "first", "running");
    item(db, "second", [PROVIDER], 2);
    const waiting: string[] = [];
    expect(
      await workspaceDispatch(db, {
        now: NOW,
        onWaiting: (ids: readonly string[]) => waiting.push(...ids),
      }),
    ).toEqual([]);
    expect(waiting).toEqual([]);
  } finally {
    db.close();
  }
});

function blocks(db: Database, blocker: string, blocked: string): void {
  db.run("INSERT INTO task_block(blocker_linear_issue_id,blocked_linear_issue_id) VALUES(?,?)", [
    `lin-item-${blocker}`,
    `lin-item-${blocked}`,
  ]);
}

test("a merge-queue item that depends on the queued item does not hold it", async () => {
  const db = tempDb();
  try {
    conflicted(db, [PROVIDER]);
    item(db, "dependent", [PROVIDER]);
    setState(db, "dependent", "merge_queue");
    item(db, "prerequisite", [PROVIDER], 2);
    blocks(db, "prerequisite", "dependent");
    expect(await workspaceDispatch(db, { now: NOW })).toEqual(["prerequisite"]);
    expect(await listItemHolds(sqliteDb(db))).toEqual([]);
  } finally {
    db.close();
  }
});

test("an item that depends on the queued item through another issue does not hold it", async () => {
  const db = tempDb();
  try {
    conflicted(db, [PROVIDER]);
    item(db, "dependent", [PROVIDER]);
    setState(db, "dependent", "merge_queue");
    item(db, "middle", null);
    setState(db, "middle", "merged");
    item(db, "prerequisite", [PROVIDER], 2);
    blocks(db, "prerequisite", "middle");
    blocks(db, "middle", "dependent");
    expect(await workspaceDispatch(db, { now: NOW })).toEqual(["prerequisite"]);
  } finally {
    db.close();
  }
});

test("an item the queued item depends on still holds it", async () => {
  const db = tempDb();
  try {
    conflicted(db, [PROVIDER]);
    item(db, "prerequisite", [PROVIDER]);
    setState(db, "prerequisite", "merge_queue");
    item(db, "dependent", [PROVIDER], 2);
    blocks(db, "dependent", "unrelated");
    expect(await workspaceDispatch(db, { now: NOW })).toEqual([]);
    expect((await listItemHolds(sqliteDb(db))).map((hold) => [hold.itemId, hold.reason])).toEqual([
      ["dependent", "overlap"],
    ]);
  } finally {
    db.close();
  }
});

/** A place in the repository's merge queue, kept while the item is back with the agent. */
function place(db: Database, id: string, readyAt: number): void {
  db.run("INSERT INTO merge_queue_entry(item_id,repository,ready_at,kept) VALUES(?,?,?,1)", [
    id,
    "owner/repo",
    readyAt,
  ]);
}

test("a merge-queue item behind the returned front does not hold it", async () => {
  const db = tempDb();
  try {
    conflicted(db, [PROVIDER]);
    item(db, "follower", [PROVIDER]);
    setState(db, "follower", "merge_queue");
    place(db, "follower", 20);
    item(db, "front", [PROVIDER], 2);
    place(db, "front", 10);
    expect(await workspaceDispatch(db, { now: NOW })).toEqual(["front"]);
    expect(await listItemHolds(sqliteDb(db))).toEqual([]);
  } finally {
    db.close();
  }
});

test("a running item does not hold a returned item that keeps its merge-queue place", async () => {
  const db = tempDb();
  try {
    conflicted(db, [PROVIDER]);
    item(db, "running", [PROVIDER]);
    setState(db, "running", "running");
    item(db, "front", [PROVIDER], 2);
    place(db, "front", 10);
    expect(await workspaceDispatch(db, { now: NOW })).toEqual(["front"]);
  } finally {
    db.close();
  }
});

test("a merge-queue item ahead of a returned item still holds it", async () => {
  const db = tempDb();
  try {
    conflicted(db, [PROVIDER]);
    item(db, "ahead", [PROVIDER]);
    setState(db, "ahead", "merge_queue");
    place(db, "ahead", 10);
    item(db, "returned", [PROVIDER], 2);
    place(db, "returned", 20);
    expect(await workspaceDispatch(db, { now: NOW })).toEqual([]);
    expect(await listItemHolds(sqliteDb(db))).toEqual([
      { itemId: "returned", reason: "overlap", blockers: ["ahead"], files: [PROVIDER] },
    ]);
  } finally {
    db.close();
  }
});

test("hot files come from conflict restarts in the last 7 days", () => {
  const db = tempDb();
  try {
    conflicted(db, ["src/old.ts"], NOW - HOT_FILE_WINDOW_MS - 1);
    expect(hotFiles(db, NOW)).toEqual([]);
    db.run("DELETE FROM work_item_repository");
    db.run("DELETE FROM rebase_return");
    db.run("DELETE FROM work_item");
    conflicted(db, [PROVIDER, "src/index.ts"]);
    expect(hotFiles(db, NOW)).toEqual([
      { repository: "owner/repo", path: PROVIDER, conflicts: 1, items: ["earlier"] },
      { repository: "owner/repo", path: "src/index.ts", conflicts: 1, items: ["earlier"] },
    ]);
  } finally {
    db.close();
  }
});

test("a conflict restart without files counts the files a merge before it shared", () => {
  const db = tempDb();
  try {
    item(db, "merged", [PROVIDER, "src/a.ts"]);
    recordConfirmedRemoteMerge(db, {
      itemId: "merged",
      repositoryOwner: "owner",
      repositoryName: "repo",
      pullNumber: 1,
      pullUrl: null,
      mergeSha: "merge",
      confirmedAt: NOW - 120_000,
    });
    item(db, "returned", [PROVIDER, "src/b.ts"]);
    recordRebaseReturn(db, {
      itemId: "returned",
      jobId: 1,
      candidate: "head-returned",
      reason: "github_queue",
      files: null,
      recordedAt: NOW - 60_000,
    });
    expect(hotFiles(db, NOW)).toEqual([
      { repository: "owner/repo", path: PROVIDER, conflicts: 1, items: ["returned"] },
    ]);
  } finally {
    db.close();
  }
});

test("a later candidate does not change the files of an earlier conflict", () => {
  const db = tempDb();
  try {
    item(db, "merged", [PROVIDER, "src/a.ts", "src/c.ts"], NOW - 200_000);
    recordConfirmedRemoteMerge(db, {
      itemId: "merged",
      repositoryOwner: "owner",
      repositoryName: "repo",
      pullNumber: 1,
      pullUrl: null,
      mergeSha: "merge",
      confirmedAt: NOW - 120_000,
    });
    item(db, "returned", [PROVIDER, "src/b.ts"], NOW - 100_000);
    recordRebaseReturn(db, {
      itemId: "returned",
      jobId: 1,
      candidate: "head-returned",
      reason: "github_queue",
      files: null,
      recordedAt: NOW - 60_000,
    });
    // The fix drops provider.ts and adds c.ts, which the merge also changed.
    saveCandidatePaths(db, {
      itemId: "returned",
      head: "head-fixed",
      paths: ["src/b.ts", "src/c.ts"],
      recordedAt: NOW - 30_000,
    });
    // A later candidate of the merged item does not change what it merged.
    saveCandidatePaths(db, {
      itemId: "merged",
      head: "head-later",
      paths: ["src/b.ts"],
      recordedAt: NOW - 10_000,
    });
    expect(hotFiles(db, NOW).map((file) => file.path)).toEqual([PROVIDER]);
  } finally {
    db.close();
  }
});

test("held items that change the same hot file start oldest first", async () => {
  const db = tempDb();
  try {
    conflicted(db, [PROVIDER]);
    item(db, "holder", [PROVIDER]);
    setState(db, "holder", "running");
    item(db, "a", [PROVIDER], 3);
    expect(await workspaceDispatch(db, { now: NOW })).toEqual([]);
    item(db, "b", [PROVIDER], 1);
    item(db, "c", [PROVIDER], 4);
    expect(await workspaceDispatch(db, { now: NOW + 1 })).toEqual([]);
    expect(await listOverlapHoldAges(sqliteDb(db))).toEqual(
      new Map([
        ["a", NOW],
        ["b", NOW + 1],
        ["c", NOW + 1],
      ]),
    );

    setState(db, "holder", "merged");
    const log: string[] = [];
    expect(
      await workspaceDispatch(db, { now: NOW + 2, log: (line: string) => log.push(line) }),
    ).toEqual(["a"]);
    expect(await listItemHolds(sqliteDb(db))).toEqual([
      { itemId: "b", reason: "overlap", blockers: ["a"], files: [PROVIDER] },
      { itemId: "c", reason: "overlap", blockers: ["a"], files: [PROVIDER] },
    ]);
    expect(log).toContain("item b held: waiting for a to start (both change provider.ts)");

    setState(db, "a", "running");
    expect(await workspaceDispatch(db, { now: NOW + 3 })).toEqual([]);
    expect((await listItemHolds(sqliteDb(db))).map((hold) => [hold.itemId, hold.blockers])).toEqual(
      [
        ["b", ["a"]],
        ["c", ["a"]],
      ],
    );
  } finally {
    db.close();
  }
});

test("an item keeps its hold age across a restart from failed and a conflict restart", async () => {
  const db = tempDb();
  try {
    conflicted(db, [PROVIDER]);
    item(db, "holder", [PROVIDER]);
    setState(db, "holder", "running");
    item(db, "a", [PROVIDER], 3);
    expect(await workspaceDispatch(db, { now: NOW })).toEqual([]);
    setState(db, "holder", "merged");
    expect(await workspaceDispatch(db, { now: NOW + 1 })).toEqual(["a"]);
    setState(db, "a", "running");
    expect(await workspaceDispatch(db, { now: NOW + 2 })).toEqual([]);
    expect(await listItemHolds(sqliteDb(db))).toEqual([]);
    expect((await listOverlapHoldAges(sqliteDb(db))).get("a")).toBe(NOW);

    setState(db, "a", "failed");
    expect(await workspaceDispatch(db, { now: NOW + 3 })).toEqual([]);
    item(db, "second", [PROVIDER]);
    setState(db, "second", "running");
    setState(db, "a", "queued");
    item(db, "c", [PROVIDER], 1);
    expect(await workspaceDispatch(db, { now: NOW + 4 })).toEqual([]);
    expect((await listOverlapHoldAges(sqliteDb(db))).get("a")).toBe(NOW);
    setState(db, "second", "merged");
    expect(await workspaceDispatch(db, { now: NOW + 5 })).toEqual(["a"]);

    setState(db, "a", "merge_queue");
    expect(await workspaceDispatch(db, { now: NOW + 6 })).toEqual([]);
    setState(db, "a", "queued");
    expect(await workspaceDispatch(db, { now: NOW + 7 })).toEqual(["a"]);
    expect(await listItemHolds(sqliteDb(db))).toEqual([
      { itemId: "c", reason: "overlap", blockers: ["a"], files: [PROVIDER] },
    ]);
    expect((await listOverlapHoldAges(sqliteDb(db))).get("a")).toBe(NOW);

    setState(db, "a", "merged");
    expect(await workspaceDispatch(db, { now: NOW + 8 })).toEqual(["c"]);
    expect((await listOverlapHoldAges(sqliteDb(db))).has("a")).toBe(false);
  } finally {
    db.close();
  }
});

test("an item without a candidate is never held, even behind an older held item", async () => {
  const db = tempDb();
  try {
    conflicted(db, [PROVIDER]);
    item(db, "holder", [PROVIDER]);
    setState(db, "holder", "running");
    item(db, "a", [PROVIDER], 3);
    expect(await workspaceDispatch(db, { now: NOW })).toEqual([]);
    item(db, "unknown", null, 4);
    expect(await workspaceDispatch(db, { now: NOW + 1 })).toEqual(["unknown"]);
    expect((await listItemHolds(sqliteDb(db))).map((hold) => hold.itemId)).toEqual(["a"]);
    expect((await listOverlapHoldAges(sqliteDb(db))).has("unknown")).toBe(false);
  } finally {
    db.close();
  }
});
