import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../core";
import {
  OutboxDispatcher,
  attachThreadIssue,
  getThreadTask,
  linkThreadContext,
  listOutbox,
  openPawsStore,
  reserveThreadIssue,
  resolveThread,
  setThreadSource,
  threadContexts,
  threadTaskForIssue,
  type Db,
  type ThreadScope,
  type ThreadSurfaceKind,
} from "../db";
import { copyMigratedPglite, sqlRun, tempStore } from "../../test/pglite";
import {
  FakeThreadSurface,
  deliverThreadEffect,
  enqueueThreadEffect,
  stopThreadDelivery,
  type ThreadSurface,
} from "./index";

const closes: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closes.splice(0)) await close();
});

const slack: ThreadScope = { workspaceId: "ws-1", surface: "slack", installationId: "T1" };
const by = (actor: string, now = 1_000) => ({ actor, now });

async function addWorkspace(db: Db, id = "ws-1") {
  await sqlRun(
    db,
    "INSERT INTO workspace (id, linear_organization_id, name, created_at) VALUES (?, ?, ?, 0)",
    [id, `org-${id}`, id],
  );
}

async function store() {
  const { db, close } = await tempStore();
  closes.push(close);
  await addWorkspace(db);
  await addWorkspace(db, "ws-2");
  return db;
}

async function dispatch(db: Db, surfaces: ThreadSurface[]) {
  const clock = new FakeClock(5_000);
  const dispatcher = new OutboxDispatcher(db, clock, { backoffBaseMs: 1_000 });
  dispatcher.setHandler(async (row) => {
    await deliverThreadEffect(db, surfaces, row);
  });
  return async (advance = 0) => {
    clock.advance(advance);
    await dispatcher.tick();
    await dispatcher.idle();
  };
}

describe("thread task mappings", () => {
  test("duplicate mention events create one task, and later messages find it", async () => {
    const db = await store();
    const place = { kind: "thread" as const, channelId: "C1", threadId: "1.0" };
    const results = await Promise.all([
      resolveThread(db, slack, place, by("U1")),
      resolveThread(db, slack, place, by("U1")),
    ]);
    expect(new Set(results.map((result) => result.task.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const later = await resolveThread(db, slack, place, by("U2", 2_000));
    expect(later).toMatchObject({ created: false, task: { id: results[0].task.id } });
    expect(later.task).toMatchObject({ linearIssueId: null, createdBy: "U1" });
    expect(await listOutbox(db)).toHaveLength(0);
  });

  test("private members, unrelated threads and other installations never share a task", async () => {
    const db = await store();
    const dm = (member: string) => ({
      kind: "private" as const,
      channelId: "D1",
      privateMember: member,
    });
    const first = await resolveThread(db, slack, dm("U1"), by("U1"));
    const second = await resolveThread(db, slack, dm("U2"), by("U2"));
    const thread = (threadId: string) => ({ kind: "thread" as const, channelId: "C1", threadId });
    const a = await resolveThread(db, slack, thread("1.0"), by("U1"));
    const b = await resolveThread(db, slack, thread("2.0"), by("U1"));
    const other = { ...slack, installationId: "T2" };
    const elsewhere = await resolveThread(db, other, thread("1.0"), by("U1"));
    const ids = [first, second, a, b, elsewhere].map((result) => result.task.id);
    expect(new Set(ids).size).toBe(5);
    expect(first.task.privateMember).toBe("U1");
    expect(await getThreadTask(db, other, a.task.id)).toBeNull();
    expect(await getThreadTask(db, { ...slack, workspaceId: "ws-2" }, a.task.id)).toBeNull();
    expect(await setThreadSource(db, other, a.task.id, null, by("U1"))).toBe(false);
  });

  test("a retried effect whose acknowledgement was lost posts once", async () => {
    const db = await store();
    const surface = new FakeThreadSurface("slack");
    const { task } = await resolveThread(
      db,
      slack,
      { kind: "thread", channelId: "C1", threadId: "1.0" },
      by("U1"),
    );
    const effect = { kind: "post" as const, effectKey: "reply-1", text: "Looking." };
    const id = await enqueueThreadEffect(db, task, effect);
    expect(await enqueueThreadEffect(db, task, effect)).toBe(id);
    surface.loseNextAcknowledgement();
    const run = await dispatch(db, [surface]);
    await run();
    await run(60_000);
    expect(surface.messages).toHaveLength(1);
    expect(surface.calls).toEqual(["delivered reply-1", "post reply-1", "delivered reply-1"]);
    expect((await listOutbox(db)).map((row) => row.status)).toEqual(["sent"]);
  });

  test("a restart keeps queued questions, the task and the stop fence", async () => {
    const pgliteDir = join(mkdtempSync(join(tmpdir(), "paws-threads-")), "pglite");
    await copyMigratedPglite(pgliteDir);
    const first = await openPawsStore({ url: null, pgliteDir });
    await addWorkspace(first.store);
    const dm = { kind: "private" as const, channelId: "D1", privateMember: "U1" };
    const asked = await resolveThread(first.store, slack, dm, by("U1"));
    const stopped = await resolveThread(
      first.store,
      slack,
      { kind: "thread", channelId: "C1", threadId: "1.0" },
      by("U2"),
    );
    const question = { kind: "post" as const, effectKey: "question:Q1", text: "Which repo?" };
    const queued = await enqueueThreadEffect(first.store, asked.task, question, "critical");
    await stopThreadDelivery(first.store, stopped.task, 2_000);
    await first.close();

    const second = await openPawsStore({ url: null, pgliteDir });
    closes.push(second.close);
    const db = second.store;
    expect((await resolveThread(db, slack, dm, by("U1", 3_000))).task.id).toBe(asked.task.id);
    expect(await enqueueThreadEffect(db, asked.task, question, "critical")).toBe(queued);
    const late = { kind: "post" as const, effectKey: "late", text: "Still here." };
    await enqueueThreadEffect(db, stopped.task, late);
    const rows = await listOutbox(db);
    expect(rows.find((row) => row.id === queued)).toMatchObject({
      status: "pending",
      idempotencyKey: `thread:${asked.task.id}:question:Q1`,
    });
    expect(rows.find((row) => row.idempotencyKey.endsWith(":late"))?.status).toBe("dropped");
  });

  test("handing a thread to a Code channel keeps one task and its pending question", async () => {
    const db = await store();
    const surface = new FakeThreadSurface("slack", ["post", "react", "code_view"]);
    const thread = { kind: "thread" as const, channelId: "C1", threadId: "1.0" };
    const { task } = await resolveThread(db, slack, thread, by("U1"));
    await enqueueThreadEffect(db, task, {
      kind: "post",
      effectKey: "approve:A1",
      text: "Approve?",
    });
    const code = { kind: "code_channel" as const, channelId: "CODE1" };
    const linked = await linkThreadContext(db, slack, task.id, code, by("U1", 2_000));
    expect(await linkThreadContext(db, slack, task.id, code, by("U1", 3_000))).toEqual(linked);
    const sub = await resolveThread(
      db,
      slack,
      { ...code, kind: "thread", threadId: "9.0" },
      by("U3"),
    );
    expect(sub).toMatchObject({ created: false, task: { id: task.id } });
    expect((await resolveThread(db, slack, thread, by("U1"))).task.id).toBe(task.id);
    const hub = { kind: "project_hub" as const, channelId: "HUB" };
    await linkThreadContext(db, slack, task.id, hub, by("U1", 4_000));
    expect((await threadContexts(db, slack, task.id)).map((context) => context.kind)).toEqual([
      "thread",
      "code_channel",
      "project_hub",
    ]);
    const other = await resolveThread(db, slack, { ...thread, threadId: "2.0" }, by("U1"));
    await expect(linkThreadContext(db, slack, other.task.id, code, by("U1"))).rejects.toThrow(
      "another task",
    );
    const run = await dispatch(db, [surface]);
    await run();
    expect(surface.messages.map((message) => message.destination.channelId)).toEqual(["CODE1"]);
  });

  test("only the private member moves a private conversation into a Code channel", async () => {
    const db = await store();
    const dm = { kind: "private" as const, channelId: "D1", privateMember: "U1" };
    const { task } = await resolveThread(db, slack, dm, by("U1"));
    const code = { kind: "code_channel" as const, channelId: "CODE1" };
    await expect(linkThreadContext(db, slack, task.id, code, by("U2"))).rejects.toThrow(
      "Only the member",
    );
    await linkThreadContext(db, slack, task.id, code, by("U1"));
    expect((await getThreadTask(db, slack, task.id))?.primaryContextId).not.toBe(
      task.primaryContextId,
    );
  });

  test("starting work attaches one Linear issue and delegation, even after a crash", async () => {
    const db = await store();
    const place = { kind: "thread" as const, channelId: "C1", threadId: "1.0" };
    const { task } = await resolveThread(db, slack, place, by("U1"));
    await setThreadSource(
      db,
      slack,
      task.id,
      { repository: "o/r", ref: "main", commit: "abc" },
      by("U1"),
    );
    const reserved = await reserveThreadIssue(db, slack, task.id, 2_000);
    expect(await reserveThreadIssue(db, slack, task.id, 3_000)).toBe(reserved);
    const attach = { linearIssueId: reserved, delegationId: "del-1", now: 4_000 };
    const attached = await attachThreadIssue(db, slack, task.id, attach);
    expect(attached).toMatchObject({
      repository: "o/r",
      sourceCommit: "abc",
      delegationId: "del-1",
    });
    expect(await attachThreadIssue(db, slack, task.id, attach)).toEqual(attached);
    await expect(
      attachThreadIssue(db, slack, task.id, { ...attach, linearIssueId: "other" }),
    ).rejects.toThrow("already has");
    const other = await resolveThread(db, slack, { ...place, threadId: "2.0" }, by("U1"));
    await expect(attachThreadIssue(db, slack, other.task.id, attach)).rejects.toThrow();
    expect((await threadTaskForIssue(db, "ws-1", reserved))?.id).toBe(task.id);
    expect(await threadTaskForIssue(db, "ws-2", reserved)).toBeNull();
  });

  for (const kind of ["slack", "buzz"] as ThreadSurfaceKind[])
    test(`the ${kind} fake meets the shared surface contract`, async () => {
      const db = await store();
      const scope = { ...slack, surface: kind };
      const surface = new FakeThreadSurface(kind);
      const { task } = await resolveThread(
        db,
        scope,
        { kind: "thread", channelId: "C1", threadId: "1.0" },
        by("U1"),
      );
      await enqueueThreadEffect(db, task, { kind: "post", effectKey: "p", text: "Hi." });
      await enqueueThreadEffect(db, task, {
        kind: "react",
        effectKey: "r",
        messageId: "m",
        emoji: "eyes",
      });
      await enqueueThreadEffect(db, task, {
        kind: "code_view",
        effectKey: "v",
        view: { diff: [] },
        fallbackText: "Diff ready.",
      });
      const run = await dispatch(db, [surface]);
      for (let round = 0; round < 3; round++) await run();
      expect(surface.messages.map((message) => message.kind)).toEqual(["post", "react", "post"]);
      expect(surface.messages.every((message) => message.destination.surface === kind)).toBe(true);
    });
});
