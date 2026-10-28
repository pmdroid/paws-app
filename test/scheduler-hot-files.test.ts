import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  HOT_FILE_WINDOW_MS,
  hotFiles,
  insertQueuedItem,
  listItemHolds,
  recordConfirmedRemoteMerge,
  recordRebaseReturn,
  saveCandidatePaths,
} from "../src/db";
import { tempDb } from "./helpers";
import { workspaceDispatch } from "./fake-workspace";

const NOW = 30 * 24 * 60 * 60 * 1000;
const PROVIDER = "src/web/src/live/provider.ts";

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

test("two items that change a hot file do not run together; the second starts after the first merges", () => {
  const db = tempDb();
  try {
    conflicted(db, [PROVIDER]);
    item(db, "first", [PROVIDER, "src/a.ts"]);
    item(db, "second", [PROVIDER, "src/b.ts"], 2);
    const log: string[] = [];
    expect(workspaceDispatch(db, { now: NOW, log: (line: string) => log.push(line) })).toEqual([
      "first",
    ]);
    expect(listItemHolds(db)).toEqual([
      { itemId: "second", reason: "overlap", blockers: ["first"], files: [PROVIDER] },
    ]);
    expect(log).toContain("item second held: waiting for first to merge (both change provider.ts)");

    setState(db, "first", "running");
    expect(workspaceDispatch(db, { now: NOW + 1 })).toEqual([]);
    setState(db, "first", "merge_queue");
    expect(workspaceDispatch(db, { now: NOW + 2 })).toEqual([]);
    expect(listItemHolds(db).map((hold) => hold.reason)).toEqual(["overlap"]);

    setState(db, "first", "merged");
    expect(workspaceDispatch(db, { now: NOW + 3 })).toEqual(["second"]);
    expect(listItemHolds(db)).toEqual([]);
  } finally {
    db.close();
  }
});

test("items that change different files run in parallel", () => {
  const db = tempDb();
  try {
    conflicted(db, [PROVIDER]);
    item(db, "first", [PROVIDER]);
    item(db, "second", ["src/b.ts"], 2);
    expect(workspaceDispatch(db, { now: NOW })).toEqual(["first", "second"]);
    expect(listItemHolds(db)).toEqual([]);
  } finally {
    db.close();
  }
});

test("a shared file that is not hot holds nothing", () => {
  const db = tempDb();
  try {
    conflicted(db, ["src/other.ts"]);
    item(db, "first", [PROVIDER]);
    item(db, "second", [PROVIDER], 2);
    expect(workspaceDispatch(db, { now: NOW })).toEqual(["first", "second"]);
  } finally {
    db.close();
  }
});

test("an item with no candidate yet is not held", () => {
  const db = tempDb();
  try {
    conflicted(db, [PROVIDER]);
    item(db, "first", [PROVIDER]);
    setState(db, "first", "running");
    item(db, "second", null, 2);
    expect(workspaceDispatch(db, { now: NOW })).toEqual(["second"]);
    expect(listItemHolds(db)).toEqual([]);
  } finally {
    db.close();
  }
});

test("a held item is not counted in the runner line", () => {
  const db = tempDb();
  try {
    conflicted(db, [PROVIDER]);
    item(db, "first", [PROVIDER]);
    setState(db, "first", "running");
    item(db, "second", [PROVIDER], 2);
    const waiting: string[] = [];
    expect(
      workspaceDispatch(db, {
        now: NOW,
        onWaiting: (ids: readonly string[]) => waiting.push(...ids),
      }),
    ).toEqual([]);
    expect(waiting).toEqual([]);
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
      { repository: "owner/repo", path: "src/index.ts", conflicts: 1, items: ["earlier"] },
      { repository: "owner/repo", path: PROVIDER, conflicts: 1, items: ["earlier"] },
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
