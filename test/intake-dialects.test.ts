import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  delegationWorkspaceIdSteps,
  emptyFailedAttemptsSteps,
  insertIntakeItemSteps,
  insertItemContinuationSteps,
  issueHasUnfinishedItemSteps,
  listDelegationItemsSteps,
  readActiveParentDelegationSteps,
  readDelegatedIntakeSteps,
  readItemDelegationSteps,
  readPublicationIdentitySteps,
  readUnlandedAttemptSteps,
  stopSessionParentDelegationSteps,
  type Db,
  type Q,
} from "../src/db";
import { forEachDialect, jsonValue, seed, withoutForeignKeys } from "./dialects";

function intakeItem(
  id: string,
  values: { position?: number; brief?: unknown; taskKey?: string; sessionKey?: string } = {},
) {
  return {
    id,
    delegationId: "delegation",
    linearIssueId: `issue-${id}`,
    linearIdentifier: `PAS-${id}`,
    title: `Title ${id}`,
    branchName: `paws/${id}`,
    position: values.position ?? 0,
    createdAt: 0,
    brief: values.brief === undefined ? undefined : JSON.stringify(values.brief),
    taskKey: values.taskKey ?? `task-${id}`,
    sessionKey: values.sessionKey ?? null,
  };
}

function insertItems(db: Db, ...items: ReturnType<typeof intakeItem>[]) {
  return db.run(function* (q) {
    for (const item of items) yield* insertIntakeItemSteps(q, item);
  });
}

function updateItem(db: Db, id: string, values: Partial<Q["t"]["workItem"]["$inferInsert"]>) {
  return db.run(function* (q) {
    yield* q.exec(q.orm.update(q.t.workItem).set(values).where(eq(q.t.workItem.id, id)));
  });
}

function session(q: Q, sessionId: string) {
  return q.orm.insert(q.t.linearSession).values({
    sessionId,
    organizationId: "org",
    oauthClientId: "client",
    appUserId: "app",
    teamId: "team",
    creatorId: "creator",
    createdAt: 0,
  });
}

forEachDialect((open) => {
  test("an intake item reads back with its delegation, and the epic names a delegated task", async () => {
    const { db, close } = await open();
    try {
      await insertItems(
        db,
        intakeItem("b", { position: 1 }),
        intakeItem("a", {
          position: 0,
          brief: { epic: { issueId: "parent", identifier: "PAS-0", title: "Epic" } },
          taskKey: "task-parent:item:issue-a",
        }),
      );
      expect(await db.run((q) => listDelegationItemsSteps(q, "delegation"))).toEqual([
        {
          id: "a",
          delegationId: "delegation",
          linearIssueId: "issue-a",
          linearIdentifier: "PAS-a",
          title: "Title a",
          state: "queued",
          branchName: "paws/a",
          position: 0,
          version: 0,
        },
        expect.objectContaining({ id: "b", position: 1 }),
      ]);
      expect(await db.run((q) => readDelegatedIntakeSteps(q, "parent", "task-parent"))).toEqual({
        delegationId: "delegation",
        linearIdentifier: "PAS-0",
        title: "Epic",
      });
      expect(await db.run((q) => readDelegatedIntakeSteps(q, "issue-b", "task-b"))).toEqual({
        delegationId: "delegation",
        linearIdentifier: "PAS-b",
        title: "Title b",
      });
      expect(await db.run((q) => readDelegatedIntakeSteps(q, "issue-a", "task-a"))).toBeNull();
      expect(await db.run((q) => readItemDelegationSteps(q, "a"))).toEqual({
        delegationId: "delegation",
        issueId: "issue-a",
        cancelRequested: 0,
      });
      expect(await db.run((q) => readItemDelegationSteps(q, "missing"))).toBeNull();
      expect(await db.run((q) => issueHasUnfinishedItemSteps(q, "issue-a"))).toBe(true);
      await updateItem(db, "a", { state: "merged" });
      expect(await db.run((q) => issueHasUnfinishedItemSteps(q, "issue-a"))).toBe(false);
    } finally {
      await close();
    }
  });

  test("a continuation records the item it continues", async () => {
    const { db, close } = await open();
    try {
      await withoutForeignKeys(db);
      await db.run((q) => insertItemContinuationSteps(q, "next", "previous", "paws/previous"));
      const rows = await db.run((q) => q.all(q.orm.select().from(q.t.itemContinuation)));
      expect(rows).toEqual([
        expect.objectContaining({
          itemId: "next",
          previousItemId: "previous",
          branch: "paws/previous",
        }),
      ]);
    } finally {
      await close();
    }
  });

  test("stopping a session stops its parent delegation and releases its issues", async () => {
    const { db, close } = await open();
    try {
      await withoutForeignKeys(db);
      const parent = {
        workspaceId: "acme",
        organizationId: "org",
        parentIssueId: "parent",
        parentIdentifier: "PAS-0",
        title: "Parent",
        ownerUserId: "owner",
        createdAt: 1,
      };
      await seed(
        db,
        (q) =>
          q.orm.insert(q.t.parentDelegation).values({
            ...parent,
            delegationId: "stopped",
            sessionId: "other",
            edges: jsonValue(q, []),
            createdAt: 0,
            stoppedAt: 5,
          }),
        (q) =>
          q.orm.insert(q.t.parentDelegation).values({
            ...parent,
            delegationId: "active",
            sessionId: "session",
            edges: jsonValue(q, []),
          }),
        (q) =>
          q.orm.insert(q.t.parentDelegationIssue).values({
            parentDelegationId: "active",
            workspaceId: "acme",
            issueId: "child",
            identifier: "PAS-1",
            title: "Child",
            position: 0,
          }),
      );
      expect(await db.run((q) => readActiveParentDelegationSteps(q, "parent"))).toEqual({
        delegationId: "active",
        parentIssueId: "parent",
        parentIdentifier: "PAS-0",
        title: "Parent",
      });
      await db.run((q) => stopSessionParentDelegationSteps(q, "session", 9));
      expect(await db.run((q) => readActiveParentDelegationSteps(q, "parent"))).toBeNull();
      const issues = await db.run((q) => q.all(q.orm.select().from(q.t.parentDelegationIssue)));
      expect(issues.map((row) => row.releasedAt)).toEqual([9]);
    } finally {
      await close();
    }
  });

  test("an unlanded attempt is the newest unmerged paws branch that ran", async () => {
    const { db, close } = await open();
    try {
      await insertItems(db, intakeItem("a"), intakeItem("b"));
      await updateItem(db, "b", { linearIssueId: "issue-a", createdAt: 1, state: "cancelled" });
      expect(await db.run((q) => readUnlandedAttemptSteps(q, "issue-a"))).toBeNull();
      await seed(
        db,
        ...["a", "b"].map(
          (itemId) => (q: Q) =>
            q.orm.insert(q.t.run).values({
              id: `run-${itemId}`,
              itemId,
              kind: "work",
              agent: "codex",
              status: "ended",
              createdAt: 0,
              updatedAt: 0,
            }),
        ),
      );
      expect(await db.run((q) => readUnlandedAttemptSteps(q, "issue-a"))).toEqual({
        id: "b",
        linearIdentifier: "PAS-b",
        branchName: "paws/b",
      });
      await updateItem(db, "b", { state: "merged" });
      expect(await db.run((q) => readUnlandedAttemptSteps(q, "issue-a"))).toEqual({
        id: "a",
        linearIdentifier: "PAS-a",
        branchName: "paws/a",
      });
      await updateItem(db, "a", { state: "completed" });
      expect(await db.run((q) => readUnlandedAttemptSteps(q, "issue-a"))).toBeNull();
    } finally {
      await close();
    }
  });

  test("an empty failed attempt from the same installation can be cleared until a job names it", async () => {
    const { db, close } = await open();
    try {
      await seed(
        db,
        (q) => session(q, "previous"),
        (q) => session(q, "incoming"),
      );
      await insertItems(db, intakeItem("a", { brief: { epic: null }, sessionKey: "previous" }));
      await updateItem(db, "a", { state: "failed", cancelRequested: 1 });
      expect(await db.run((q) => emptyFailedAttemptsSteps(q, "issue-a", "incoming"))).toEqual([
        "a",
      ]);
      expect(await db.run((q) => emptyFailedAttemptsSteps(q, "issue-a", "previous"))).toEqual([]);
      await seed(db, (q) =>
        q.orm.insert(q.t.job).values({
          queue: "work",
          payload: jsonValue(q, { itemId: "a" }),
          runAt: 0,
          createdAt: 0,
        }),
      );
      expect(await db.run((q) => emptyFailedAttemptsSteps(q, "issue-a", "incoming"))).toEqual([]);
    } finally {
      await close();
    }
  });

  test("a publication identity names the run, specification, session and actor", async () => {
    const { db, close } = await open();
    try {
      await seed(
        db,
        (q) => session(q, "session"),
        (q) =>
          q.orm
            .insert(q.t.workspace)
            .values({ id: "acme", linearOrganizationId: "org", name: "Acme", createdAt: 0 }),
        (q) =>
          q.orm.insert(q.t.workspaceUser).values({
            id: "owner",
            linearUserId: "linear-owner",
            name: "Owner",
            email: "o@example.com",
          }),
      );
      await insertItems(db, intakeItem("a", { sessionKey: "session" }));
      expect(await db.run((q) => delegationWorkspaceIdSteps(q, "delegation"))).toBe("acme");
      expect(await db.run((q) => delegationWorkspaceIdSteps(q, "missing"))).toBeUndefined();
      await seed(
        db,
        (q) =>
          q.orm.insert(q.t.run).values({
            id: "run",
            itemId: "a",
            kind: "work",
            agent: "codex",
            status: "active",
            createdAt: 0,
            updatedAt: 0,
          }),
        (q) =>
          q.orm
            .insert(q.t.workItemSpecification)
            .values({ itemId: "a", hash: "hash", revision: 2, present: 1 }),
      );
      await db.run(function* (q) {
        yield* q.exec(
          q.orm
            .update(q.t.workItem)
            .set({
              state: "verifying",
              currentRunId: "run",
              ownerUserId: "owner",
              checkpoint: jsonValue(q, { wipCommit: "abc" }),
            })
            .where(eq(q.t.workItem.id, "a")),
        );
      });
      const identity = await db.run((q) => readPublicationIdentitySteps(q, "a"));
      expect({ ...identity, checkpoint: JSON.parse(identity?.checkpoint ?? "null") }).toEqual({
        delegationId: "delegation",
        workspaceId: "acme",
        checkpoint: { wipCommit: "abc" },
        runId: "run",
        agent: "codex",
        runKind: "work",
        runStatus: "active",
        specificationHash: "hash",
        specificationRevision: 2,
        sessionId: "session",
        sessionGeneration: 0,
        organizationId: "org",
        teamId: "team",
        clientId: "client",
        appUserId: "app",
        creatorId: "creator",
        actorId: "linear-owner",
      });
      await updateItem(db, "a", { cancelRequested: 1 });
      expect(await db.run((q) => readPublicationIdentitySteps(q, "a"))).toBeNull();
    } finally {
      await close();
    }
  });
});
