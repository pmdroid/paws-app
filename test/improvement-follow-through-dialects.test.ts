import { afterEach, expect, test } from "bun:test";
import {
  annotateImprovementCriterionSteps,
  bindImprovementWorkSteps,
  boundImprovementWorkSteps,
  bumpImprovementVersionSteps,
  claimImprovementDelegationSteps,
  closeoutStepResultSteps,
  expiredImprovementDelegationsSteps,
  followThroughCandidatesSteps,
  improvementDelegationSteps,
  improvementIssueSyncSteps,
  improvementWorkBindingSteps,
  listImprovementActionsSteps,
  markImprovementCheckedSteps,
  newestIssueWorkSteps,
  otherDelegationForIssueSteps,
  recordImprovementActionSteps,
  recordImprovementIssueSyncSteps,
  returnImprovementToReviewSteps,
  settleImprovementDelegationSteps,
  type Db,
} from "../src/db";
import {
  forEachDialect,
  insertWorkItem,
  seed,
  withoutForeignKeys,
  type DialectDb,
} from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

async function connected(connect: () => Promise<DialectDb>) {
  const handle = await connect();
  open.push(handle);
  await withoutForeignKeys(handle.db);
  return handle.db;
}

function seedImprovement(
  db: Db,
  id: string,
  values: { issueId?: string | null; reviewState?: string; version?: number } = {},
) {
  return seed(db, (q) =>
    q.orm.insert(q.t.improvement).values({
      id,
      workspaceId: "ws",
      repository: "acme/app",
      createdAt: 1,
      issueId: values.issueId === undefined ? `issue-${id}` : values.issueId,
      reviewState: values.reviewState ?? "accepted",
      ...((values.reviewState ?? "accepted") === "accepted"
        ? { intent: "create", reviewedProposal: 1 }
        : {}),
      version: values.version ?? 1,
    }),
  );
}

forEachDialect((connect) => {
  test("an issue sync records the newest observation and keeps the last available state", async () => {
    const db = await connected(connect);
    await seedImprovement(db, "imp");
    const record = (input: Parameters<typeof recordImprovementIssueSyncSteps>[1]) =>
      db.run((q) => recordImprovementIssueSyncSteps(q, input));
    expect(await db.run((q) => improvementIssueSyncSteps(q, "imp"))).toBeNull();
    expect(
      await record({ improvementId: "imp", issueId: "other", status: "available", observedAt: 5 }),
    ).toBe(false);
    expect(
      await record({
        improvementId: "imp",
        issueId: "issue-imp",
        status: "available",
        stateType: "started",
        teamId: "team",
        delegated: true,
        observedAt: 10,
      }),
    ).toBe(true);
    expect(
      await record({
        improvementId: "imp",
        issueId: "issue-imp",
        status: "missing",
        observedAt: 9,
      }),
    ).toBe(false);
    expect(
      await record({
        improvementId: "imp",
        issueId: "issue-imp",
        status: "missing",
        observedAt: 11,
      }),
    ).toBe(true);
    expect(await db.run((q) => improvementIssueSyncSteps(q, "imp"))).toEqual({
      improvementId: "imp",
      issueId: "issue-imp",
      status: "missing",
      stateType: "started",
      teamId: "team",
      delegated: true,
      observedAt: 11,
      confirmedAt: 10,
    });
  });

  test("follow-through candidates come least recently checked first", async () => {
    const db = await connected(connect);
    await seedImprovement(db, "a");
    await seedImprovement(db, "b");
    await seedImprovement(db, "c");
    await seedImprovement(db, "unlinked", { issueId: null });
    await seedImprovement(db, "open", { reviewState: "needs_review" });
    await db.run((q) => markImprovementCheckedSteps(q, "a", 5));
    await db.run((q) => markImprovementCheckedSteps(q, "b", 9));
    await db.run((q) => markImprovementCheckedSteps(q, "b", 3));
    expect(await db.run((q) => followThroughCandidatesSteps(q, 10))).toEqual([
      { id: "c", workspaceId: "ws", issueId: "issue-c" },
      { id: "b", workspaceId: "ws", issueId: "issue-b" },
      { id: "a", workspaceId: "ws", issueId: "issue-a" },
    ]);
    expect(await db.run((q) => followThroughCandidatesSteps(q, 1))).toHaveLength(1);
  });

  test("a delegation is claimed, settled, reclaimed and expires", async () => {
    const db = await connected(connect);
    const claim = (now: number, again?: boolean) =>
      db.run((q) =>
        claimImprovementDelegationSteps(q, {
          improvementId: "imp",
          issueId: "issue",
          actor: "person",
          now,
          leaseMs: 10,
          again,
        }),
      );
    expect(await claim(100)).toEqual({
      improvementId: "imp",
      issueId: "issue",
      state: "requested",
      sessionId: null,
      error: null,
      attempts: 1,
      leaseExpiresAt: 110,
      actor: "person",
      requestedAt: 100,
      updatedAt: 100,
    });
    expect(await claim(105)).toBeNull();
    expect(await db.run((q) => expiredImprovementDelegationsSteps(q, 109))).toEqual([]);
    expect(await db.run((q) => expiredImprovementDelegationsSteps(q, 110))).toHaveLength(1);
    expect((await claim(110))?.attempts).toBe(2);
    const settle = (attempts: number) =>
      db.run((q) =>
        settleImprovementDelegationSteps(q, {
          improvementId: "imp",
          attempts,
          state: "started",
          sessionId: "session",
          now: 111,
        }),
      );
    expect(await settle(1)).toBe(false);
    expect(await settle(2)).toBe(true);
    expect(await settle(2)).toBe(false);
    expect(await claim(112)).toBeNull();
    expect(await claim(112, true)).toMatchObject({ state: "requested", attempts: 3 });
    expect(
      await db.run((q) =>
        settleImprovementDelegationSteps(q, {
          improvementId: "imp",
          attempts: 3,
          state: "failed",
          error: "no",
          now: 113,
        }),
      ),
    ).toBe(true);
    expect(await db.run((q) => improvementDelegationSteps(q, "imp"))).toMatchObject({
      state: "failed",
      sessionId: "session",
      error: "no",
      leaseExpiresAt: null,
      updatedAt: 113,
    });
    expect(await db.run((q) => improvementDelegationSteps(q, "missing"))).toBeNull();
  });

  test("another improvement's delegation holds the issue until its work finishes", async () => {
    const db = await connected(connect);
    const claim = (improvementId: string, now: number) =>
      db.run((q) =>
        claimImprovementDelegationSteps(q, {
          improvementId,
          issueId: "issue-item",
          actor: "person",
          now,
          leaseMs: 10,
        }),
      );
    const other = (now: number) =>
      db.run((q) =>
        otherDelegationForIssueSteps(q, { improvementId: "mine", issueId: "issue-item", now }),
      );
    await claim("theirs", 100);
    expect((await other(105))?.improvementId).toBe("theirs");
    expect(await other(110)).toBeNull();
    await db.run((q) =>
      settleImprovementDelegationSteps(q, {
        improvementId: "theirs",
        attempts: 1,
        state: "started",
        now: 106,
      }),
    );
    expect((await other(200))?.improvementId).toBe("theirs");
    await insertWorkItem(db, "item", 100);
    await seed(db, (q) => q.orm.update(q.t.workItem).set({ state: "merged" }));
    expect(await other(200)).toBeNull();
  });

  test("an action bumps the expected version and keeps its JSON", async () => {
    const db = await connected(connect);
    await seedImprovement(db, "imp", { version: 2 });
    const record = (expectedVersion: number) =>
      db.transaction((q) =>
        recordImprovementActionSteps(q, {
          improvementId: "imp",
          expectedVersion,
          action: "verify",
          prior: { state: "unknown", list: [1, 2] },
          detail: { note: null },
          actor: "person",
          now: 50,
        }),
      );
    expect(await record(1)).toBeNull();
    expect(await record(2)).toBe(3);
    await db.run((q) => bumpImprovementVersionSteps(q, "imp"));
    expect(await record(4)).toBe(5);
    const actions = await db.run((q) => listImprovementActionsSteps(q, "imp"));
    expect(actions.map((action) => action.version)).toEqual([3, 5]);
    expect(actions[0]).toEqual({
      id: actions[0]!.id,
      improvementId: "imp",
      action: "verify",
      version: 3,
      prior: { state: "unknown", list: [1, 2] },
      detail: { note: null },
      actor: "person",
      at: 50,
    });
    expect(typeof actions[0]!.id).toBe("number");
  });

  test("criteria take the next revision", async () => {
    const db = await connected(connect);
    for (const criterion of ["first", "second"])
      await db.run((q) =>
        annotateImprovementCriterionSteps(q, {
          improvementId: "imp",
          proposalVersion: 1,
          criterion,
          actor: "person",
          now: 1,
        }),
      );
    const rows = await db.run((q) => q.all(q.orm.select().from(q.t.improvementCriterion)));
    expect(rows.map((row) => [row.revision, row.criterion]).sort()).toEqual([
      [1, "first"],
      [2, "second"],
    ]);
  });

  test("returning to review clears follow-through and records the decision", async () => {
    const db = await connected(connect);
    await seedImprovement(db, "imp", { version: 3 });
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.improvementDelivery).values({
          id: "delivery",
          improvementId: "imp",
          workspaceId: "ws",
          operation: "create_issue",
          state: "pending",
          createdAt: 1,
          updatedAt: 1,
        } as typeof q.t.improvementDelivery.$inferInsert),
      (q) =>
        q.orm.insert(q.t.improvementWork).values({
          improvementId: "imp",
          issueId: "issue-imp",
          itemId: "item",
          boundAt: 1,
        }),
    );
    await db.run((q) => markImprovementCheckedSteps(q, "imp", 1));
    await db.transaction((q) =>
      returnImprovementToReviewSteps(q, { improvementId: "imp", version: 3, actor: "p", now: 9 }),
    );
    expect(await db.run((q) => improvementWorkBindingSteps(q, "imp"))).toBeNull();
    const [row] = await db.run((q) => q.all(q.orm.select().from(q.t.improvement)));
    expect(row).toMatchObject({
      reviewState: "needs_review",
      reviewedBy: "p",
      reviewedAt: 9,
      issueId: null,
      implementationAt: 9,
      verificationAt: 9,
    });
    expect(await db.run((q) => q.all(q.orm.select().from(q.t.improvementDelivery)))).toHaveLength(
      0,
    );
    expect(await db.run((q) => q.all(q.orm.select().from(q.t.improvementDecision)))).toMatchObject([
      { improvementId: "imp", version: 3, reviewState: "needs_review" },
    ]);
  });

  test("work binds once, rebinds from the expected item, and reads back with its pull request", async () => {
    const db = await connected(connect);
    await seedImprovement(db, "imp", { issueId: "issue-old" });
    const bind = (itemId: string, expectedItemId: string | null) =>
      db.run((q) =>
        bindImprovementWorkSteps(q, {
          improvementId: "imp",
          issueId: "issue-old",
          itemId,
          expectedItemId,
          now: 7,
        }),
      );
    expect(await bind("old", "missing")).toBe(false);
    expect(await bind("old", null)).toBe(true);
    expect(await bind("new", null)).toBe(false);
    expect(await bind("new", "other")).toBe(false);
    expect(await bind("old", "old")).toBe(true);
    expect(await db.run((q) => improvementWorkBindingSteps(q, "imp"))).toEqual({
      issueId: "issue-old",
      itemId: "old",
      boundAt: 7,
    });
    await insertWorkItem(db, "old", 10);
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.workItemRepository).values({
          itemId: "old",
          owner: "acme",
          repo: "app",
          remoteUrl: "https://example.test/acme/app.git",
        }),
      (q) =>
        q.orm
          .insert(q.t.itemPullRequest)
          .values({ itemId: "old", pullNumber: 4, pullUrl: null, openedAt: 12 }),
      (q) =>
        q.orm.insert(q.t.workItemEvent).values({
          itemId: "old",
          version: 1,
          at: 15,
          fromState: "queued",
          toState: "running",
          event: "started",
        }),
    );
    const bound = (repository: string) =>
      db.run((q) => boundImprovementWorkSteps(q, { id: "imp", issueId: "issue-old", repository }));
    expect(await bound("acme/other")).toBeNull();
    expect(await bound("acme/app")).toEqual({
      itemId: "old",
      state: "queued",
      identifier: "old",
      repository: "acme/app",
      createdAt: 10,
      updatedAt: 15,
      acceptedHead: null,
      pull: { number: 4, url: null, openedAt: 12 },
      merge: null,
    });
  });

  test("the newest issue work skips finished work from before the link", async () => {
    const db = await connected(connect);
    await insertWorkItem(db, "a", 10);
    await insertWorkItem(db, "b", 20);
    await seed(db, (q) =>
      q.orm.update(q.t.workItem).set({ linearIssueId: "issue", state: "completed" }),
    );
    const newest = (input: { linkedAt: number; exceptItemId?: string }) =>
      db.run((q) =>
        newestIssueWorkSteps(q, {
          issueId: "issue",
          repository: "acme/app",
          createdSince: 0,
          ...input,
        }),
      );
    expect((await newest({ linkedAt: 0 }))?.itemId).toBe("b");
    expect((await newest({ linkedAt: 0, exceptItemId: "b" }))?.itemId).toBe("a");
    expect((await newest({ linkedAt: 15, exceptItemId: "b" }))?.itemId).toBeUndefined();
    const work = await newest({ linkedAt: 0 });
    expect(work).toMatchObject({ repository: null, updatedAt: 20, pull: null, merge: null });
  });

  test("a closeout step result carries its progress item and head", async () => {
    const db = await connected(connect);
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.closeoutProgress).values({
          id: "progress",
          itemId: "item",
          taskId: "task",
          base: "base",
          head: "head",
          policyDigest: "digest",
          startedAt: 1,
          updatedAt: 1,
        } as typeof q.t.closeoutProgress.$inferInsert),
      (q) =>
        q.orm.insert(q.t.closeoutStep).values(
          [1, 2].map(
            (attempt) =>
              ({
                progressId: "progress",
                stepId: attempt === 2 ? "test" : "lint",
                kind: "command",
                state: attempt === 2 ? "passed" : "failed",
                command: "bun test",
                attempt,
                ordinal: attempt,
                finishedAt: attempt === 2 ? 30 : null,
              }) as typeof q.t.closeoutStep.$inferInsert,
          ),
        ),
    );
    expect(await db.run((q) => closeoutStepResultSteps(q, "progress", "test"))).toEqual({
      progressId: "progress",
      stepId: "test",
      itemId: "item",
      head: "head",
      kind: "command",
      state: "passed",
      command: "bun test",
      finishedAt: 30,
    });
    expect(await db.run((q) => closeoutStepResultSteps(q, "progress", "build"))).toBeNull();
  });
});
