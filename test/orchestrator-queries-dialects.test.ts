import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { JOB_KIND } from "../src/core";
import {
  bumpItemVersionSteps,
  cancelItemPendingJobsSteps,
  dropUnsentSessionActivitySteps,
  hasOpenItemJobSteps,
  itemDelegationIssueIdSteps,
  itemParentTaskKeySteps,
  landedTaskBlockersSteps,
  latestRestartEventSteps,
  latestRunningAnswerSteps,
  linearOutboxKeyedSteps,
  listItemIdsSteps,
  openTaskDependentsSteps,
  pausedStoppedSessionItemSteps,
  previousIssueSessionIdsSteps,
  recentRepositoryNamesSteps,
  type Db,
  type Q,
} from "../src/db";
import {
  forEachDialect,
  insertWorkItem,
  json,
  seed,
  withoutForeignKeys,
  type DialectDb,
} from "./dialects";

const opened: DialectDb[] = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
});

async function connect(open: () => Promise<DialectDb>, ...items: string[]): Promise<Db> {
  const handle = await open();
  opened.push(handle);
  for (const [index, id] of items.entries()) await insertWorkItem(handle.db, id, index);
  await withoutForeignKeys(handle.db);
  return handle.db;
}

const item = (id: string, fields: Record<string, unknown>) => (q: Q) =>
  q.orm.update(q.t.workItem).set(fields).where(eq(q.t.workItem.id, id));

const session =
  (sessionId: string, fields: Record<string, unknown> = {}) =>
  (q: Q) =>
    q.orm.insert(q.t.linearSession).values({
      sessionId,
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      teamId: "team",
      createdAt: 0,
      ...fields,
    });

forEachDialect((open) => {
  test("a dependency hands off the latest landed blocker in its delegation", async () => {
    const db = await connect(open, "old", "blocker", "blocked", "elsewhere");
    await seed(
      db,
      item("old", { delegationId: "d", linearIssueId: "issue-blocker", state: "merged" }),
      item("blocker", {
        delegationId: "d",
        linearIssueId: "issue-blocker",
        state: "merged",
        currentRunId: "run",
      }),
      item("blocked", { delegationId: "d" }),
      item("elsewhere", { linearIssueId: "issue-blocker", state: "merged" }),
      (q) =>
        q.orm.insert(q.t.run).values({
          id: "run",
          itemId: "blocker",
          kind: "implement",
          agent: "codex",
          status: "ended",
          checkpoint: json(db, { resultBody: "Done." }),
          createdAt: 0,
          updatedAt: 0,
        }),
      (q) =>
        q.orm
          .insert(q.t.taskBlock)
          .values({ blockerLinearIssueId: "issue-blocker", blockedLinearIssueId: "issue-blocked" }),
    );
    const blockers = await db.run((q) => landedTaskBlockersSteps(q, "d", "issue-blocked"));
    expect(blockers.map(({ id, identifier }) => ({ id, identifier }))).toEqual([
      { id: "blocker", identifier: "blocker" },
    ]);
    expect(JSON.parse(blockers[0]!.checkpoint!)).toEqual({ resultBody: "Done." });
    expect(await db.run((q) => openTaskDependentsSteps(q, "d", "issue-blocker"))).toEqual([
      { id: "blocked", identifier: "blocked" },
    ]);
    await seed(db, (q) =>
      q.orm
        .insert(q.t.workItemSpecification)
        .values({ itemId: "blocker", hash: "h", revision: 1, present: 0 }),
    );
    const fallback = await db.run((q) => landedTaskBlockersSteps(q, "d", "issue-blocked"));
    expect(fallback).toEqual([{ id: "old", identifier: "old", checkpoint: null }]);
    expect((await db.run((q) => listItemIdsSteps(q, false))).toSorted()).toEqual([
      "blocked",
      "elsewhere",
      "old",
    ]);
    expect(await db.run((q) => listItemIdsSteps(q, true))).toHaveLength(4);
  });

  test("a redelegation finds the previous and the stopped sessions of its issue", async () => {
    const db = await connect(open, "a", "b");
    await seed(
      db,
      session("incoming", { teamId: null }),
      session("stopped", { teamId: null, stoppedAt: 5 }),
      session("in-team"),
      session("same-team"),
      session("other-team", { teamId: "other" }),
      item("a", { sessionKey: "stopped", state: "paused", linearIssueId: "issue" }),
      item("b", { sessionKey: "same-team", state: "cancelled", linearIssueId: "issue" }),
    );
    expect(await db.run((q) => pausedStoppedSessionItemSteps(q, "incoming", "issue"))).toEqual({
      id: "a",
      sessionKey: "stopped",
      delegationId: "delegation-a",
    });
    expect(await db.run((q) => pausedStoppedSessionItemSteps(q, "in-team", "issue"))).toBeNull();
    expect(await db.run((q) => previousIssueSessionIdsSteps(q, "incoming", "issue"))).toEqual([]);
    expect(await db.run((q) => previousIssueSessionIdsSteps(q, "in-team", "issue"))).toEqual([
      "same-team",
    ]);
    expect(await db.run((q) => previousIssueSessionIdsSteps(q, "other-team", "issue"))).toEqual([]);
  });

  test("an item's task key and delegation issue come from its brief", async () => {
    const db = await connect(open, "a");
    await seed(
      db,
      item("a", { taskKey: "task:item:issue-a", brief: json(db, { epic: { issueId: "epic" } }) }),
    );
    expect(await db.run((q) => itemParentTaskKeySteps(q, "a"))).toBe("task");
    expect(await db.run((q) => itemDelegationIssueIdSteps(q, "a"))).toBe("epic");
    await db.run((q) => bumpItemVersionSteps(q, "a"));
    await db.run((q) => bumpItemVersionSteps(q, "a"));
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.workItemEvent).values({
          itemId: "a",
          version: 1,
          at: 0,
          fromState: "verifying",
          toState: "queued",
          event: "restart",
          kind: "restart",
          reason: "ci",
        }),
      (q) =>
        q.orm.insert(q.t.workItemRepository).values({
          itemId: "a",
          owner: "Acme",
          repo: "App",
          remoteUrl: "https://github.com/Acme/App.git",
        }),
    );
    expect(await db.run((q) => latestRestartEventSteps(q, "a"))).toEqual({
      reason: "ci",
      version: 1,
    });
    expect(await db.run((q) => recentRepositoryNamesSteps(q, 50))).toEqual(["acme/app"]);
    const [stored] = await db.run((q) =>
      q.all(q.orm.select({ version: q.t.workItem.version }).from(q.t.workItem)),
    );
    expect(stored!.version).toBe(2);
  });

  test("a run's latest answer carries its options as JSON text", async () => {
    const db = await connect(open, "a");
    await seed(db, item("a", { state: "running" }), (q) =>
      q.orm.insert(q.t.question).values({
        id: "question",
        itemId: "a",
        runId: "run",
        sessionId: "s",
        body: "Which?",
        options: json(db, ["one", "two"]),
        status: "answered",
        answer: "one",
        createdAt: 0,
        answeredAt: 1,
      }),
    );
    const answered = await db.run((q) => latestRunningAnswerSteps(q, "run"));
    expect(answered).toMatchObject({ id: "question", itemId: "a", answer: "one" });
    expect(JSON.parse(answered!.options!)).toEqual(["one", "two"]);
  });

  test("an item's open jobs are found and its pending ones cancelled", async () => {
    const db = await connect(open);
    await seed(db, (q) =>
      q.orm.insert(q.t.job).values({
        queue: JOB_KIND.start,
        payload: json(db, { itemId: "a" }),
        runAt: 0,
        createdAt: 0,
      }),
    );
    const [{ id }] = (await db.run((q) =>
      q.all(q.orm.select({ id: q.t.job.id }).from(q.t.job)),
    )) as [{ id: number }];
    expect(await db.run((q) => hasOpenItemJobSteps(q, JOB_KIND.start, "a"))).toBe(true);
    expect(await db.run((q) => hasOpenItemJobSteps(q, JOB_KIND.start, "a", id))).toBe(false);
    await db.run((q) => cancelItemPendingJobsSteps(q, "a", 9));
    expect(await db.run((q) => hasOpenItemJobSteps(q, JOB_KIND.start, "a"))).toBe(false);
  });

  test("a sent first activity drops its unsent duplicate", async () => {
    const db = await connect(open);
    const activity = (key: string, body: string) => (q: Q) =>
      q.orm.insert(q.t.outbox).values({
        target: "linear",
        op: "activity",
        orderingKey: "s",
        idempotencyKey: key,
        payload: json(db, { body }),
        createdAt: 0,
      });
    await seed(db, activity("pull-request-ready:a:1", "first"), activity("other", "second"));
    expect(await db.run((q) => linearOutboxKeyedSteps(q, "pull-request-ready:a:"))).toBe(true);
    await db.run((q) =>
      dropUnsentSessionActivitySteps(q, {
        orderingKey: "s",
        body: "first",
        error: "Sent.",
        now: 1,
      }),
    );
    expect(await db.run((q) => linearOutboxKeyedSteps(q, "pull-request-ready:a:"))).toBe(false);
    expect(await db.run((q) => linearOutboxKeyedSteps(q, "oth"))).toBe(true);
  });
});
