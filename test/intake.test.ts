import { describe, expect, test } from "bun:test";
import { eq, notInArray, sql } from "drizzle-orm";
import { WORK_ITEM_STATES } from "../src/core";
import { listTaskBlockers, migrations, syncSteps, type Db, type Q } from "../src/db";
import { cycleMessage, intakeDelegatedIssue, orderByBlocks, queueMessage } from "../src/intake";
import { createFakeTracker, type EpicSnapshot } from "../src/linear";
import { tempStore } from "./pglite";

const parent: EpicSnapshot = {
  linearIssueId: "parent",
  identifier: "ENG-1",
  title: "Add CSV export",
  description: null,
  subIssues: [
    { linearIssueId: "a", identifier: "ENG-2", title: "export endpoint" },
    { linearIssueId: "b", identifier: "ENG-3", title: "same file" },
    { linearIssueId: "c", identifier: "ENG-4", title: "decision" },
  ],
};

const epicTables = (db: Db) => db.run((q) => epicTablesSteps(q));

function epicTablesSteps(q: Q) {
  return q.all(
    q.orm
      .select({ name: sql<string>`table_name` })
      .from(sql`information_schema.tables`)
      .where(sql`table_name = 'epic'`),
  );
}

const workItems = (db: Db) =>
  db.run((q) =>
    q.all(q.orm.select({ id: q.t.workItem.id, state: q.t.workItem.state }).from(q.t.workItem)),
  );

const parentDelegations = (db: Db) =>
  db.run((q) =>
    q.all(q.orm.select({ id: q.t.parentDelegation.delegationId }).from(q.t.parentDelegation)),
  );

const setStates = (db: Db, state: string, id?: string) =>
  db.run((q) =>
    q.exec(
      q.orm
        .update(q.t.workItem)
        .set({ state })
        .where(id === undefined ? undefined : eq(q.t.workItem.id, id)),
    ),
  );

function* seedOwnerSteps(q: Q) {
  yield* q.exec(
    q.orm
      .insert(q.t.workspace)
      .values({ id: "workspace", linearOrganizationId: "org", name: "Workspace", createdAt: 1000 }),
  );
  yield* q.exec(
    q.orm.insert(q.t.workspaceUser).values({
      id: "person",
      linearUserId: "linear-person",
      name: "Person",
      email: "person@example.test",
    }),
  );
}

function* adoptSteps(q: Q) {
  yield* q.exec(
    q.orm.insert(q.t.parentDelegation).values({
      delegationId: "adopted",
      workspaceId: "workspace",
      organizationId: "org",
      parentIssueId: "parent",
      parentIdentifier: "ENG-1",
      title: "Parent",
      sessionId: "ses_1",
      ownerUserId: "person",
      edges: [],
      createdAt: 1,
    }),
  );
  return true;
}

describe("intake", () => {
  test("the migrated schema accepts every work-item state", async () => {
    const { db, close } = await tempStore();
    const check = await db.run((q) =>
      q.one(
        q.orm
          .select({ definition: sql<string>`pg_get_constraintdef(oid)` })
          .from(sql`pg_constraint`)
          .where(sql`conname = 'work_item_check_1'`),
      ),
    );
    expect(await epicTables(db)).toEqual([]);
    for (const state of WORK_ITEM_STATES) expect(check?.definition).toContain(`'${state}'`);
    expect(migrations[0]?.id).toBe("001_jobs_outbox");
    await close();
  });

  test("orders a parent by a blocks edge and keeps the original tie break", async () => {
    const { db, close } = await tempStore();
    const tracker = createFakeTracker([parent]);
    tracker.deps.set("parent", [{ blockerLinearIssueId: "a", blockedLinearIssueId: "b" }]);
    const result = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      sessionId: "ses_1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.delegation.state).toBe("running");
    expect(result.items.map((item) => item.linearIdentifier)).toEqual(["ENG-2", "ENG-3", "ENG-4"]);
    expect(result.items.map((item) => item.state)).toEqual(["queued", "queued", "queued"]);
    expect(result.items[0]?.branchName).toBe("paws/eng-2");
    expect(tracker.progress.map((update) => update.body)).toEqual([
      queueMessage(["ENG-2", "ENG-3", "ENG-4"], false),
    ]);
    const blocks = await db.run((q) =>
      q.all(
        q.orm
          .select({
            blocker: q.t.taskBlock.blockerLinearIssueId,
            blocked: q.t.taskBlock.blockedLinearIssueId,
          })
          .from(q.t.taskBlock),
      ),
    );
    expect(blocks).toEqual([{ blocker: "a", blocked: "b" }]);
    const again = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      sessionId: "ses_1",
    });
    expect(again.ok && again.alreadyExisted).toBe(true);
    expect(tracker.progress).toHaveLength(1);
    await close();
  });

  test("a lone delegated issue is a queue of one", async () => {
    const { db, close } = await tempStore();
    const tracker = createFakeTracker([
      {
        linearIssueId: "only",
        identifier: "ENG-9",
        title: "Fix the header",
        description: "details",
        subIssues: [],
      },
    ]);
    const result = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "only",
      sessionId: "ses_9",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      linearIdentifier: "ENG-9",
      state: "queued",
      branchName: "paws/eng-9",
    });
    expect(tracker.progress[0]?.body).toBe("Picked up ENG-9.");
    await close();
  });

  test("adopting a parent finishes the delegation without items and leaves the parent session to its summary", async () => {
    const { db, close } = await tempStore();
    const tracker = createFakeTracker([
      {
        linearIssueId: "parent",
        identifier: "ENG-1",
        title: "Parent",
        description: null,
        subIssues: [{ linearIssueId: "only", identifier: "ENG-2", title: "Only child" }],
      },
    ]);
    let epicExisted = true;
    const result = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      sessionId: "ses_1",
      adoptParent: function* (q) {
        epicExisted = (yield* epicTablesSteps(q)).length > 0;
        yield* seedOwnerSteps(q);
        return yield* adoptSteps(q);
      },
    });
    expect(epicExisted).toBe(false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alreadyExisted).toBe(false);
    expect(result.items).toEqual([]);
    expect(result.delegation.state).toBe("done");
    expect(result.delegation.id).toBe("adopted");
    expect(await epicTables(db)).toEqual([]);
    expect(tracker.progress.map((update) => update.body)).toEqual([]);
    const again = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      sessionId: "ses_1",
      adoptParent: () => {
        throw new Error("replay must not adopt again");
      },
    });
    expect(again.ok && again.alreadyExisted).toBe(true);
    if (!again.ok) return;
    expect(again.items).toEqual([]);
    expect(again.delegation.id).toBe(result.delegation.id);
    expect(tracker.progress).toHaveLength(0);
    await close();
  });

  test("adoptParent false keeps the ordered multi-item delegation", async () => {
    const { db, close } = await tempStore();
    const tracker = createFakeTracker([parent]);
    const result = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      sessionId: "ses_1",
      adoptParent: () => syncSteps(() => false),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.delegation.state).toBe("running");
    expect(result.items.map((item) => item.linearIdentifier)).toEqual(["ENG-2", "ENG-3", "ENG-4"]);
    expect(tracker.progress.map((update) => update.body)).toEqual([
      queueMessage(["ENG-2", "ENG-3", "ENG-4"], false),
    ]);
    expect(await parentDelegations(db)).toHaveLength(0);
    await close();
  });

  test("a blocks cycle does not adopt a parent", async () => {
    const { db, close } = await tempStore();
    const tracker = createFakeTracker([parent]);
    tracker.deps.set("a", [
      { blockerLinearIssueId: "a", blockedLinearIssueId: "b" },
      { blockerLinearIssueId: "b", blockedLinearIssueId: "a" },
    ]);
    let called = false;
    const result = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      sessionId: "ses_1",
      adoptParent: () =>
        syncSteps(() => {
          called = true;
          return true;
        }),
    });
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("cycle");
    expect(await parentDelegations(db)).toHaveLength(0);
    await close();
  });

  test("a blocks cycle is reported and nothing is queued", async () => {
    const { db, close } = await tempStore();
    const tracker = createFakeTracker([parent]);
    tracker.deps.set("a", [
      { blockerLinearIssueId: "a", blockedLinearIssueId: "b" },
      { blockerLinearIssueId: "b", blockedLinearIssueId: "a" },
    ]);
    const result = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      sessionId: "ses_1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("cycle");
    expect(result.identifiers).toEqual(["ENG-2", "ENG-3"]);
    expect(result.delegation.state).toBe("stalled");
    expect(await workItems(db)).toHaveLength(0);
    expect(tracker.progress[0]).toMatchObject({
      kind: "error",
      body: cycleMessage(["ENG-2", "ENG-3"]),
    });
    const ordered = orderByBlocks(
      [
        { linearIssueId: "a", identifier: "ENG-2", title: "a" },
        { linearIssueId: "b", identifier: "ENG-3", title: "b" },
      ],
      [
        { blockerLinearIssueId: "a", blockedLinearIssueId: "b" },
        { blockerLinearIssueId: "b", blockedLinearIssueId: "a" },
      ],
    );
    expect(ordered.ok).toBe(false);
    await close();
  });

  test("intake stores internal and external task blocks for the queued issues", async () => {
    const { db, close } = await tempStore();
    const tracker = createFakeTracker([parent]);
    tracker.deps.set("parent", [
      { blockerLinearIssueId: "a", blockedLinearIssueId: "b" },
      { blockerLinearIssueId: "outside", blockedLinearIssueId: "b" },
      { blockerLinearIssueId: "b", blockedLinearIssueId: "outside" },
    ]);
    const result = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      sessionId: "ses_1",
    });
    expect(result.ok).toBe(true);
    expect(await listTaskBlockers(db, "b")).toEqual(["a", "outside"]);
    expect(await listTaskBlockers(db, "a")).toEqual([]);
    expect(await listTaskBlockers(db, "outside")).toEqual([]);
    await close();
  });

  test("an issue already active in another session is rejected and creates nothing", async () => {
    const { db, close } = await tempStore();
    const tracker = createFakeTracker([
      {
        linearIssueId: "only",
        identifier: "ENG-9",
        title: "Fix the header",
        description: null,
        subIssues: [],
      },
    ]);
    const first = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "only",
      sessionId: "ses_1",
      taskKey: "first",
    });
    expect(first.ok).toBe(true);
    const message =
      "ENG-9 has an unfinished attempt in another Paws session. Reply in that session to continue, or stop it before starting a new one.";
    await expect(
      intakeDelegatedIssue(db, tracker, {
        linearIssueId: "only",
        sessionId: "ses_2",
        taskKey: "second",
      }),
    ).rejects.toThrow(message);
    expect(tracker.progress).toContainEqual(
      expect.objectContaining({ sessionId: "ses_2", kind: "error", body: message }),
    );
    expect(await epicTables(db)).toHaveLength(0);
    expect(await workItems(db)).toHaveLength(1);
    expect((await workItems(db))[0]?.state).toBe("queued");
    await close();
  });

  test.each(["merged", "completed", "cancelled"] as const)(
    "delegating an issue whose earlier item is %s creates a new item",
    async (state) => {
      const { db, close } = await tempStore();
      const tracker = createFakeTracker([
        {
          linearIssueId: "only",
          identifier: "ENG-9",
          title: "Fix the header",
          description: null,
          subIssues: [],
        },
      ]);
      const first = await intakeDelegatedIssue(db, tracker, {
        linearIssueId: "only",
        sessionId: "ses_1",
        taskKey: "first",
      });
      if (!first.ok) throw new Error("expected intake");
      await setStates(db, state, first.items[0]!.id);
      const second = await intakeDelegatedIssue(db, tracker, {
        linearIssueId: "only",
        sessionId: "ses_2",
        taskKey: "second",
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.alreadyExisted).toBe(false);
      expect(second.items).toHaveLength(1);
      expect(second.items[0]?.state).toBe("queued");
      expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
      expect(await workItems(db)).toHaveLength(2);
      await close();
    },
  );

  test("beforeAdmit cancels the previous item before the replacement is inserted", async () => {
    const { db, close } = await tempStore();
    const tracker = createFakeTracker([
      {
        linearIssueId: "only",
        identifier: "ENG-9",
        title: "Fix the header",
        description: null,
        subIssues: [],
      },
    ]);
    const first = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "only",
      sessionId: "ses_1",
      taskKey: "first",
    });
    if (!first.ok) throw new Error("expected intake");
    let activeBefore = -1;
    const second = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "only",
      sessionId: "ses_1",
      taskKey: "second",
      beforeAdmit: function* (q) {
        const { workItem } = q.t;
        activeBefore = (yield* q.all(
          q.orm
            .select({ id: workItem.id })
            .from(workItem)
            .where(notInArray(workItem.state, ["completed", "merged", "cancelled"])),
        )).length;
        yield* q.exec(
          q.orm
            .update(workItem)
            .set({ state: "cancelled" })
            .where(eq(workItem.id, first.items[0]!.id)),
        );
      },
    });
    expect(activeBefore).toBe(1);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect((await workItems(db)).find((row) => row.id === first.items[0]!.id)?.state).toBe(
      "cancelled",
    );
    expect(second.items[0]?.state).toBe("queued");
    expect(await workItems(db)).toHaveLength(2);
    await close();
  });

  test("a repeated delegation of the same issue replays without an epic row", async () => {
    const { db, close } = await tempStore();
    const tracker = createFakeTracker([
      {
        linearIssueId: "only",
        identifier: "ENG-9",
        title: "Fix the header",
        description: null,
        subIssues: [],
      },
    ]);
    const result = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "only",
      sessionId: "ses_9",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.delegation.state).toBe("running");
    expect(await epicTables(db)).toEqual([]);
    const again = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "only",
      sessionId: "ses_9",
    });
    expect(again.ok && again.alreadyExisted).toBe(true);
    if (!again.ok) return;
    expect(again.delegation.id).toBe(result.delegation.id);
    expect(again.items.map((item) => item.id)).toEqual(result.items.map((item) => item.id));
    expect(tracker.progress).toHaveLength(1);
    await setStates(db, "cancelled");
    const cancelled = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "only",
      sessionId: "ses_9",
    });
    expect(cancelled.ok && cancelled.delegation.state).toBe("cancelled");
    await setStates(db, "merged");
    const done = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "only",
      sessionId: "ses_9",
    });
    expect(done.ok && done.delegation.state).toBe("done");
    expect(await epicTables(db)).toEqual([]);
    await close();
  });

  test("an adopted parent replays from its parent delegation", async () => {
    const { db, close } = await tempStore();
    const tracker = createFakeTracker([
      {
        linearIssueId: "parent",
        identifier: "ENG-1",
        title: "Parent",
        description: null,
        subIssues: [{ linearIssueId: "only", identifier: "ENG-2", title: "Only child" }],
      },
    ]);
    await db.run(seedOwnerSteps);
    const result = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      sessionId: "ses_1",
      taskKey: "parent-task",
      adoptParent: adoptSteps,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alreadyExisted).toBe(false);
    expect(result.items).toEqual([]);
    expect(result.delegation).toMatchObject({
      id: "adopted",
      linearIssueId: "parent",
      linearIdentifier: "ENG-1",
      title: "Parent",
      state: "done",
    });
    expect(await epicTables(db)).toEqual([]);
    const again = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      sessionId: "ses_1",
      taskKey: "parent-followup",
      adoptParent: () => {
        throw new Error("replay must not adopt again");
      },
    });
    expect(again.ok && again.alreadyExisted).toBe(true);
    if (!again.ok) return;
    expect(again.delegation.id).toBe("adopted");
    expect(again.items).toEqual([]);
    expect(tracker.progress).toHaveLength(0);
    expect(await epicTables(db)).toEqual([]);
    await close();
  });

  test("a cycle stores no epic row and reports the cycle again", async () => {
    const { db, close } = await tempStore();
    const tracker = createFakeTracker([parent]);
    tracker.deps.set("a", [
      { blockerLinearIssueId: "a", blockedLinearIssueId: "b" },
      { blockerLinearIssueId: "b", blockedLinearIssueId: "a" },
    ]);
    const result = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      sessionId: "ses_1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("cycle");
    expect(result.identifiers).toEqual(["ENG-2", "ENG-3"]);
    expect(result.delegation.state).toBe("stalled");
    expect(result.alreadyExisted).toBe(false);
    expect(await epicTables(db)).toEqual([]);
    expect(await workItems(db)).toEqual([]);
    const again = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      sessionId: "ses_1",
    });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toBe("cycle");
    expect(again.identifiers).toEqual(["ENG-2", "ENG-3"]);
    expect(again.alreadyExisted).toBe(false);
    expect(tracker.progress.map((update) => update.body)).toEqual([
      cycleMessage(["ENG-2", "ENG-3"]),
      cycleMessage(["ENG-2", "ENG-3"]),
    ]);
    expect(await epicTables(db)).toEqual([]);
    await close();
  });
});
