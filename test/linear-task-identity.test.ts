import { expect, test } from "bun:test";
import {
  JobLoop,
  OutboxDispatcher,
  activateLinearItem,
  advanceLinearSessionGeneration,
  applyLinearTurns,
  bindLinearSessionTask,
  ensureLinearSession,
  getLinearSession,
  getLinearSessionGeneration,
  getTaskLinearActor,
  getWorkItem,
  listPendingLinearTurns,
  migrate,
  migrations,
  openDatabase,
  recordLinearTurn,
} from "../src/db";
import { createFakeTracker } from "../src/linear";
import { intakeDelegatedIssue } from "../src/intake";
import { attachOrchestrator, itemPathId } from "../src/loop";
import { systemClock } from "../src/core";
import { tempDb } from "./helpers";

const snapshot = {
  linearIssueId: "issue",
  identifier: "ENG-1",
  title: "Request",
  description: null,
  subIssues: [],
};

async function task(db: ReturnType<typeof tempDb>, key?: string) {
  const result = await intakeDelegatedIssue(db, createFakeTracker([snapshot]), {
    linearIssueId: "issue",
    taskKey: key,
  });
  if (!result.ok) throw new Error("Unexpected cycle");
  return result;
}

test("identity migration preserves existing rows, run foreign keys and original intake dedupe", async () => {
  const db = openDatabase(":memory:");
  try {
    db.run(
      "CREATE TABLE schema_migration (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
    );
    for (const migration of migrations.filter((entry) => entry.id !== "012_linear_task_identity")) {
      db.run(migration.sql);
      db.run("INSERT INTO schema_migration VALUES (?,0)", [migration.id]);
    }
    db.run(
      "INSERT INTO epic (id,linear_issue_id,linear_identifier,title,state,created_at) VALUES ('epic','issue','ENG-1','Original','done',1)",
    );
    db.run(
      "INSERT INTO work_item (id,epic_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key) VALUES ('item','epic','issue','ENG-1','Original','merged','paws/eng-1',0,1,'session')",
    );
    db.run(
      "INSERT INTO run (id,item_id,kind,agent,status,created_at,updated_at) VALUES ('run','item','implement','claude','ended',1,1)",
    );
    for (const [id, state, position] of [
      ["running", "running", 1],
      ["queued", "queued", 2],
    ] as const)
      db.run(
        "INSERT INTO work_item (id,epic_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key) VALUES (?,'epic',?,'ENG-2','Child',?,'paws/eng-2',?,1,'session')",
        [id, id, state, position],
      );
    for (const [id, source, session] of [
      ["github", "github:owner/repo#1", "github:owner/repo#1"],
      ["comments", "comment-issue", "comment-issue"],
    ]) {
      db.run(
        "INSERT INTO epic (id,linear_issue_id,linear_identifier,title,state,created_at) VALUES (?,?,'ENG-3','Synthetic','running',1)",
        [id!, source!],
      );
      db.run(
        "INSERT INTO work_item (id,epic_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key) VALUES (?,?,?,'ENG-3','Synthetic','queued','paws/eng-3',0,1,?)",
        [id!, id!, source!, session!],
      );
    }
    migrate(db);
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(getWorkItem(db, "item")?.state).toBe("merged");
    expect(getLinearSession(db, "session")?.epicId).toBe("epic");
    expect(getLinearSession(db, "session")?.activeItemId).toBe("running");
    activateLinearItem(db, "session", "running");
    expect(() => activateLinearItem(db, "session", "queued")).toThrow("still active");
    db.run("UPDATE work_item SET state = 'failed' WHERE id = 'running'");
    activateLinearItem(db, "session", "queued");
    expect(getLinearSession(db, "session")?.activeItemId).toBe("queued");
    expect(getLinearSession(db, "github:owner/repo#1")).toBeNull();
    expect(getLinearSession(db, "comment-issue")).toBeNull();
    expect((await task(db)).alreadyExisted).toBe(true);
    expect((await task(db, "turn:correction")).alreadyExisted).toBe(false);
    expect(
      db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM work_item WHERE linear_issue_id = 'issue'",
        )
        .get()?.n,
    ).toBe(2);
    expect(
      db.query<{ item_id: string }, []>("SELECT item_id FROM run WHERE id = 'run'").get()?.item_id,
    ).toBe("item");
    expect(getWorkItem(db, "item")?.state).toBe("merged");
  } finally {
    db.close();
  }
});

test("new tasks keep source IDs and get separate worktree identities while intake replay is stable", async () => {
  const db = tempDb();
  try {
    const initial = await task(db);
    const later = await task(db, "turn:followup");
    const replay = await task(db, "turn:followup");
    expect(replay.epic.id).toBe(later.epic.id);
    expect(initial.epic.id).not.toBe(later.epic.id);
    const first = getWorkItem(db, initial.items[0]!.id)!;
    const next = getWorkItem(db, later.items[0]!.id)!;
    expect(first.linearIssueId).toBe(next.linearIssueId);
    expect(itemPathId(first)).toBe("ENG-1");
    expect(itemPathId(next)).toContain(next.id);
    expect(itemPathId(first)).not.toBe(itemPathId(next));
  } finally {
    db.close();
  }
});

test("session ownership and active child routing remain separate from shared issue identity", async () => {
  const db = tempDb();
  try {
    const first = await task(db);
    const second = await task(db, "session:second");
    ensureLinearSession(db, {
      sessionId: "first",
      issueId: "issue",
      organizationId: "org",
      appUserId: "app",
      creatorId: "human",
    });
    bindLinearSessionTask(db, "first", first.epic.id);
    activateLinearItem(db, "first", first.items[0]!.id);
    ensureLinearSession(db, { sessionId: "second", issueId: "issue" });
    bindLinearSessionTask(db, "second", second.epic.id);
    activateLinearItem(db, "second", second.items[0]!.id);
    expect(getTaskLinearActor(db, first.items[0]!.id)).toBe("human");
    expect(getTaskLinearActor(db, second.items[0]!.id)).toBeNull();
    expect(() => ensureLinearSession(db, { sessionId: "first", organizationId: "other" })).toThrow(
      "ownership changed",
    );
    expect(() => bindLinearSessionTask(db, "second", first.epic.id)).toThrow();
    expect(() => activateLinearItem(db, "second", first.items[0]!.id)).toThrow("route changed");
    expect(getWorkItem(db, first.items[0]!.id)?.sessionKey).toBe("first");
  } finally {
    db.close();
  }
});

test("prompt before hydration persists, ordered duplicates apply once and Stop fences pending turns", async () => {
  const db = tempDb();
  try {
    const turn = (eventKey: string, createdAtMs: number) => ({
      eventKey,
      activityId: eventKey,
      sessionId: "session",
      actorId: "human",
      body: eventKey,
      payload: "{}",
      createdAtMs,
    });
    recordLinearTurn(db, turn("later", 20));
    recordLinearTurn(db, turn("earlier", 10));
    recordLinearTurn(db, { ...turn("later", 20), body: "Edited comment" });
    expect(getLinearSession(db, "session")?.epicId).toBeNull();
    expect(listPendingLinearTurns(db, "session").map((entry) => entry.body)).toEqual([
      "earlier",
      "later",
    ]);
    const result = await task(db);
    bindLinearSessionTask(db, "session", result.epic.id, { actorId: "human" });
    const itemId = result.items[0]!.id;
    activateLinearItem(db, "session", itemId);
    applyLinearTurns(db, "session", ["earlier"], itemId);
    applyLinearTurns(db, "session", ["earlier"], itemId);
    expect(listPendingLinearTurns(db, "session").map((entry) => entry.eventKey)).toEqual(["later"]);
    expect(advanceLinearSessionGeneration(db, "session", { stop: true, now: 30 })).toBe(1);
    expect(getLinearSessionGeneration(db, "session")).toBe(1);
    expect(listPendingLinearTurns(db, "session")).toEqual([]);
    recordLinearTurn(db, turn("after-stop", 40));
    expect(listPendingLinearTurns(db, "session").map((entry) => entry.eventKey)).toEqual([
      "after-stop",
    ]);
  } finally {
    db.close();
  }
});

test("created sessions sharing an issue keep separate tasks and preserve earlier routing", async () => {
  const db = tempDb();
  try {
    const tracker = createFakeTracker([snapshot]);
    const orchestrator = attachOrchestrator({
      db,
      tracker,
      jobs: new JobLoop(db, systemClock),
      outbox: new OutboxDispatcher(db, systemClock),
      pawsRoot: "/tmp/unused-identity-fixture",
    });
    const created = (sessionId: string) => ({
      dedupeKey: `session:${sessionId}:created`,
      deliveryId: null,
      source: "webhook" as const,
      action: "created" as const,
      sessionId,
      issueId: "issue",
      activityId: null,
      body: null,
      signal: null,
      updatedAtMs: 10,
      payload: JSON.stringify({
        organizationId: "org",
        appUserId: "app",
        agentSession: { creatorId: "human" },
      }),
    });
    await task(db);
    await Promise.all([
      orchestrator.onLinearEvent(created("first")),
      orchestrator.onLinearEvent(created("concurrent")),
    ]);
    const concurrent = getLinearSession(db, "concurrent")!;
    const first = getLinearSession(db, "first")!;
    await orchestrator.onLinearEvent(created("second"));
    await orchestrator.onLinearEvent(created("second"));
    const second = getLinearSession(db, "second")!;
    expect(first.epicId).not.toBe(second.epicId);
    expect(first.epicId).not.toBe(concurrent.epicId);
    expect(concurrent.epicId).not.toBe(second.epicId);
    expect(getWorkItem(db, first.activeItemId!)?.sessionKey).toBe("first");
    expect(getWorkItem(db, second.activeItemId!)?.sessionKey).toBe("second");
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM epic").get()?.n).toBe(4);
    expect(getTaskLinearActor(db, second.activeItemId!)).toBe("human");
    await orchestrator.onLinearEvent({
      ...created("before-created"),
      dedupeKey: "activity:early",
      action: "prompted",
      activityId: "early",
      body: "Do this after hydration",
    });
    expect(listPendingLinearTurns(db, "before-created")[0]?.body).toBe("Do this after hydration");
    await orchestrator.onLinearEvent(created("before-created"));
    expect(getLinearSession(db, "before-created")?.activeItemId).not.toBeNull();
    expect(listPendingLinearTurns(db, "before-created")).toHaveLength(1);
  } finally {
    db.close();
  }
});
