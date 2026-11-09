import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  askedQuestionOpenSteps,
  branchHeldByOtherItemSteps,
  branchRunnerWorkSteps,
  cancelAcceptedWorkJobsSteps,
  clearCheckpointRefCleanupSteps,
  commentOpenedAgentSessionSteps,
  delegationParentTaskKeySteps,
  endedCheckpointRefItemsSteps,
  enqueueJobSteps,
  enqueueOutboxSteps,
  getJobSteps,
  githubDeliveryRecordedSteps,
  issueItemsCreatedBySteps,
  itemsForLinearIssueSteps,
  latestMergeJobSummarySteps,
  latestRunUpdateSteps,
  linearSessionGenerationSteps,
  linearStoppedAfterSteps,
  openItemIdForPullSteps,
  openItemIdsForRepositorySteps,
  openMergeJobsSteps,
  outboxKeyExistsSteps,
  parentIssueSessionSteps,
  pendingAnswerHandoffsSteps,
  recordGitHubDeliverySteps,
  releasePushOutageJobsSteps,
  runningJobIdSteps,
  sessionHasFinalResponseSteps,
  sessionIssueTeamNameSteps,
  setQuestionHandoffVersionSteps,
  setRetryAnswerSteps,
  teamRepositoryAllowedSteps,
  type Db,
  type Q,
} from "../src/db";
import { JOB_KIND } from "../src/core";
import {
  forEachDialect,
  insertLinearSession,
  insertWorkItem,
  jsonValue,
  withoutForeignKeys,
  type DialectDb,
} from "./dialects";

const opened: DialectDb[] = [];

afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
});

async function connect(open: () => Promise<DialectDb>): Promise<Db> {
  const handle = await open();
  opened.push(handle);
  await withoutForeignKeys(handle.db);
  return handle.db;
}

function item(db: Db, id: string, set: Partial<Q["t"]["workItem"]["$inferInsert"]>) {
  return db.run(function* (q) {
    yield* q.exec(q.orm.update(q.t.workItem).set(set).where(eq(q.t.workItem.id, id)));
  });
}

function question(db: Db, id: string, set: Partial<Q["t"]["question"]["$inferInsert"]> = {}) {
  return db.run(function* (q) {
    yield* q.exec(
      q.orm.insert(q.t.question).values({
        id,
        itemId: "item",
        sessionId: "session",
        body: id,
        status: "open",
        createdAt: 1,
        ...set,
      }),
    );
  });
}

function inbox(
  db: Db,
  key: string,
  set: { issueId?: string; sessionId?: string },
  payload: object,
) {
  return db.run(function* (q) {
    yield* q.exec(
      q.orm.insert(q.t.inboxEvent).values({
        dedupeKey: key,
        source: "webhook",
        action: "created",
        updatedAtMs: 1,
        receivedAt: Number(key),
        payload: jsonValue(q, payload),
        ...set,
      }),
    );
  });
}

function repository(db: Db, itemId: string, owner: string, repo: string) {
  return db.run(function* (q) {
    yield* q.exec(
      q.orm.insert(q.t.workItemRepository).values({ itemId, owner, repo, remoteUrl: "url" }),
    );
  });
}

forEachDialect((open) => {
  test("accepted work cancels the item's start and resume jobs, except the current one", async () => {
    const db = await connect(open);
    const ids = await db.run(function* (q) {
      const start = yield* enqueueJobSteps(q, {
        queue: JOB_KIND.start,
        payload: { itemId: "item" },
        now: 1,
      });
      const resume = yield* enqueueJobSteps(q, {
        queue: JOB_KIND.resume,
        payload: { itemId: "item" },
        now: 1,
      });
      const other = yield* enqueueJobSteps(q, {
        queue: JOB_KIND.start,
        payload: { itemId: "other" },
        now: 1,
      });
      const merge = yield* enqueueJobSteps(q, {
        queue: JOB_KIND.merge,
        payload: { itemId: "item" },
        now: 1,
      });
      yield* cancelAcceptedWorkJobsSteps(q, "item", 9, resume);
      return { start, resume, other, merge };
    });
    const job = (id: number) => db.run((q) => getJobSteps(q, id));
    expect(await job(ids.start)).toMatchObject({
      status: "cancelled",
      lastError: "accepted_work",
      finishedAt: 9,
    });
    expect((await job(ids.resume))?.status).toBe("pending");
    expect((await job(ids.other))?.status).toBe("pending");
    expect((await job(ids.merge))?.status).toBe("pending");
  });

  test("the newest merge job gives the item's summary", async () => {
    const db = await connect(open);
    const payload = (summary: string) => ({ itemId: "item", summary });
    await db.run(function* (q) {
      yield* enqueueJobSteps(q, { queue: JOB_KIND.merge, payload: payload("old"), now: 1 });
      yield* enqueueJobSteps(q, { queue: JOB_KIND.merge, payload: payload("new"), now: 2 });
      yield* enqueueJobSteps(q, { queue: JOB_KIND.start, payload: payload("start"), now: 3 });
    });
    expect(await db.run((q) => latestMergeJobSummarySteps(q, "item"))).toBe("new");
    expect(await db.run((q) => latestMergeJobSummarySteps(q, "none"))).toBeNull();
  });

  test("a running job is found by queue and key", async () => {
    const db = await connect(open);
    const id = await db.run(function* (q) {
      const created = yield* enqueueJobSteps(q, { queue: JOB_KIND.resume, jobKey: "turn", now: 1 });
      yield* q.exec(
        q.orm.update(q.t.job).set({ status: "running" }).where(eq(q.t.job.id, created)),
      );
      return created;
    });
    expect(await db.run((q) => runningJobIdSteps(q, JOB_KIND.resume, "turn"))).toBe(id);
    expect(await db.run((q) => runningJobIdSteps(q, JOB_KIND.merge, "turn"))).toBeNull();
  });

  test("open merge jobs carry their payload as JSON text", async () => {
    const db = await connect(open);
    const id = await db.run((q) =>
      enqueueJobSteps(q, {
        queue: JOB_KIND.merge,
        payload: { itemId: "item", head: "abc" },
        now: 1,
      }),
    );
    await db.run((q) => enqueueJobSteps(q, { queue: JOB_KIND.start, payload: {}, now: 1 }));
    const jobs = await db.run((q) => openMergeJobsSteps(q));
    expect(jobs.map((job) => job.id)).toEqual([id]);
    expect(JSON.parse(jobs[0]!.payload)).toEqual({ itemId: "item", head: "abc" });
  });

  test("the end of a push outage releases only its pending merge jobs", async () => {
    const db = await connect(open);
    const ids = await db.run(function* (q) {
      const held = yield* enqueueJobSteps(q, {
        queue: JOB_KIND.merge,
        payload: { pushOutage: "acme/app" },
        runAt: 500,
        now: 1,
      });
      const elsewhere = yield* enqueueJobSteps(q, {
        queue: JOB_KIND.merge,
        payload: { pushOutage: "acme/other" },
        runAt: 500,
        now: 1,
      });
      yield* releasePushOutageJobsSteps(q, "acme/app", 20);
      return { held, elsewhere };
    });
    expect((await db.run((q) => getJobSteps(q, ids.held)))?.runAt).toBe(20);
    expect((await db.run((q) => getJobSteps(q, ids.elsewhere)))?.runAt).toBe(500);
  });

  test("a session's generation, final response and keyed rows", async () => {
    const db = await connect(open);
    const final = await db.run(function* (q) {
      yield* q.exec(
        q.orm
          .insert(q.t.outboxSessionFence)
          .values({ target: "linear", orderingKey: "session", generation: 3, updatedAt: 1 }),
      );
      return yield* enqueueOutboxSteps(q, {
        target: "linear",
        op: "activity",
        orderingKey: "session",
        generation: 3,
        idempotencyKey: "merged:item",
        payload: {},
        now: 1,
      });
    });
    expect(await db.run((q) => linearSessionGenerationSteps(q, "session"))).toBe(3);
    expect(await db.run((q) => linearSessionGenerationSteps(q, "none"))).toBe(0);
    const closed = (generation: number, rowId?: number) =>
      db.run((q) => sessionHasFinalResponseSteps(q, "session", generation, rowId));
    expect(await closed(3)).toBe(true);
    expect(await closed(2)).toBe(false);
    expect(await closed(3, final)).toBe(false);
    expect(await closed(3, final + 1)).toBe(true);
    expect(await db.run((q) => outboxKeyExistsSteps(q, "merged:item"))).toBe(true);
    expect(await db.run((q) => outboxKeyExistsSteps(q, "merged:none"))).toBe(false);
  });

  test("a recorded GitHub delivery is found by id", async () => {
    const db = await connect(open);
    await db.run((q) =>
      recordGitHubDeliverySteps(q, { deliveryId: "d1", event: "push", payload: "{}" }, 1),
    );
    expect(await db.run((q) => githubDeliveryRecordedSteps(q, "d1"))).toBe(true);
    expect(await db.run((q) => githubDeliveryRecordedSteps(q, "d2"))).toBe(false);
  });

  test("open items are found by repository and pull request, ignoring case", async () => {
    const db = await connect(open);
    await insertWorkItem(db, "older", 1);
    await insertWorkItem(db, "newer", 2);
    await insertWorkItem(db, "ended", 3);
    await item(db, "ended", { state: "merged" });
    for (const id of ["older", "newer", "ended"]) await repository(db, id, "Acme", "App");
    await db.run(function* (q) {
      yield* q.exec(
        q.orm.insert(q.t.itemPullRequest).values([
          { itemId: "older", pullNumber: 7, openedAt: 1 },
          { itemId: "ended", pullNumber: 8, openedAt: 1 },
        ]),
      );
    });
    expect(await db.run((q) => openItemIdsForRepositorySteps(q, "acme", "app"))).toEqual([
      "newer",
      "older",
    ]);
    expect(await db.run((q) => openItemIdForPullSteps(q, "ACME", "app", 7))).toBe("older");
    expect(await db.run((q) => openItemIdForPullSteps(q, "acme", "app", 8))).toBeNull();
  });

  test("work item lookups by delegation, branch and issue", async () => {
    const db = await connect(open);
    await insertWorkItem(db, "first", 1);
    await insertWorkItem(db, "second", 2);
    await item(db, "first", {
      delegationId: "d",
      linearIssueId: "issue",
      taskKey: "task:item:issue",
      branchName: "shared",
    });
    await item(db, "second", {
      delegationId: "d",
      linearIssueId: "issue",
      branchName: "shared",
      state: "merged",
    });
    expect(await db.run((q) => delegationParentTaskKeySteps(q, "d"))).toBe("task");
    expect(await db.run((q) => delegationParentTaskKeySteps(q, "none"))).toBeNull();
    expect(await db.run((q) => branchHeldByOtherItemSteps(q, "shared", "second"))).toBe(true);
    expect(await db.run((q) => branchHeldByOtherItemSteps(q, "shared", "first"))).toBe(false);
    expect(await db.run((q) => itemsForLinearIssueSteps(q, "issue"))).toEqual([
      { id: "second", state: "merged", createdAt: 2 },
      { id: "first", state: "queued", createdAt: 1 },
    ]);
    await insertLinearSession(db, "session", "issue");
    await db.run(function* (q) {
      yield* q.exec(
        q.orm
          .update(q.t.linearSession)
          .set({ organizationId: "org" })
          .where(eq(q.t.linearSession.sessionId, "session")),
      );
    });
    await item(db, "first", { sessionKey: "session" });
    expect(await db.run((q) => issueItemsCreatedBySteps(q, "issue", 1))).toEqual([
      {
        id: "first",
        identifier: "first",
        state: "queued",
        sessionKey: "session",
        organizationId: "org",
      },
    ]);
  });

  test("a branch's runner work and the latest run update", async () => {
    const db = await connect(open);
    await insertWorkItem(db, "item");
    await item(db, "item", { branchName: "b" });
    await db.run(function* (q) {
      const run = (id: string, updatedAt: number) =>
        q.orm.insert(q.t.run).values({
          id,
          itemId: "item",
          kind: "code",
          agent: "codex",
          status: "ended",
          createdAt: 1,
          updatedAt,
        });
      yield* q.exec(run("r1", 5));
      yield* q.exec(run("r2", 9));
      yield* q.exec(
        q.orm.insert(q.t.runnerWork).values([
          {
            runId: "r1",
            runnerId: "box",
            workspaceId: "acme",
            generation: 1,
            runnerFence: 1,
            commandId: "c1",
            leaseUntil: 1,
            endedAt: 7,
          },
          {
            runId: "r2",
            runnerId: "box",
            workspaceId: "acme",
            generation: 1,
            runnerFence: 1,
            commandId: "c2",
            leaseUntil: 1,
          },
        ]),
      );
    });
    const work = await db.run((q) => branchRunnerWorkSteps(q, "b"));
    expect(work.sort((a, b) => a.runId.localeCompare(b.runId))).toEqual([
      { runId: "r1", endedAt: 7 },
      { runId: "r2", endedAt: null },
    ]);
    expect(await db.run((q) => latestRunUpdateSteps(q, ["item"]))).toBe(9);
    expect(await db.run((q) => latestRunUpdateSteps(q, ["none"]))).toBeNull();
    expect(await db.run((q) => latestRunUpdateSteps(q, []))).toBeNull();
  });

  test("a later Stop and a parent session with open sub-issue work", async () => {
    const db = await connect(open);
    await insertLinearSession(db, "parent", "epic");
    await db.run(function* (q) {
      yield* q.exec(
        q.orm
          .insert(q.t.linearStopReceipt)
          .values({ sessionId: "parent", eventKey: "stop", generation: 2, createdAt: 1 }),
      );
    });
    expect(await db.run((q) => linearStoppedAfterSteps(q, "parent", 1))).toBe(true);
    expect(await db.run((q) => linearStoppedAfterSteps(q, "parent", 2))).toBe(false);
    expect(await db.run((q) => parentIssueSessionSteps(q, "epic"))).toBeNull();
    await insertWorkItem(db, "child");
    await item(db, "child", {
      linearIssueId: "sub",
      brief: jsonBrief(db, { epic: { issueId: "epic" } }),
    });
    expect(await db.run((q) => parentIssueSessionSteps(q, "epic"))).toBe("parent");
    await item(db, "child", { state: "merged" });
    expect(await db.run((q) => parentIssueSessionSteps(q, "epic"))).toBeNull();
  });

  test("webhook payloads name the comment's session and the issue's team", async () => {
    const db = await connect(open);
    await inbox(db, "1", { issueId: "issue" }, { agentSession: { comment: { id: "c1" } } });
    await inbox(db, "2", { issueId: "issue" }, { agentActivity: { sourceCommentId: "c2" } });
    await inbox(db, "3", { issueId: "other" }, { sourceCommentId: "c3" });
    const carried = (issue: string, comment: string) =>
      db.run((q) => commentOpenedAgentSessionSteps(q, issue, comment));
    expect(await carried("issue", "c1")).toBe(true);
    expect(await carried("issue", "c2")).toBe(true);
    expect(await carried("issue", "c3")).toBe(false);

    const team = (name: unknown) => ({ agentSession: { issue: { team: { name } } } });
    await inbox(db, "10", { sessionId: "s" }, team("Old"));
    await inbox(db, "20", { sessionId: "s" }, team("Platform"));
    await inbox(db, "30", { sessionId: "s" }, team(" "));
    expect(await db.run((q) => sessionIssueTeamNameSteps(q, "s"))).toBe("Platform");
    expect(await db.run((q) => sessionIssueTeamNameSteps(q, "none"))).toBeNull();
  });

  test("a team uses its mapped repositories, or the catalog when it maps none", async () => {
    const db = await connect(open);
    await db.run(function* (q) {
      yield* q.exec(
        q.orm.insert(q.t.workspaceRepository).values({
          workspaceId: "acme",
          teamId: "mapped",
          repository: "Acme/App",
        }),
      );
      yield* q.exec(
        q.orm.insert(q.t.repositoryCatalog).values({
          repository: "acme/lib",
          owner: "acme",
          repo: "lib",
          remoteUrl: "url",
          defaultBranch: "main",
          refreshedAt: 1,
        }),
      );
    });
    const allowed = (team: string, repo: string) =>
      db.run((q) => teamRepositoryAllowedSteps(q, "acme", team, repo));
    expect(await allowed("mapped", "acme/app")).toBe(true);
    expect(await allowed("mapped", "acme/lib")).toBe(false);
    expect(await allowed("unmapped", "acme/lib")).toBe(true);
    expect(await allowed("unmapped", "acme/app")).toBe(false);
  });

  test("checkpoint refs wait for cleanup in the order their items ended", async () => {
    const db = await connect(open);
    await db.run(function* (q) {
      yield* q.exec(
        q.orm.insert(q.t.checkpointRefCleanup).values([
          { itemId: "late", endedAt: 2 },
          { itemId: "early", endedAt: 1 },
        ]),
      );
    });
    expect(await db.run((q) => endedCheckpointRefItemsSteps(q))).toEqual(["early", "late"]);
    await db.run((q) => clearCheckpointRefCleanupSteps(q, "early"));
    expect(await db.run((q) => endedCheckpointRefItemsSteps(q))).toEqual(["late"]);
  });

  test("answered questions wait for a handoff until a version is recorded", async () => {
    const db = await connect(open);
    const answered = (id: string, answeredAt: number, kind = "agent") =>
      question(db, id, {
        status: "answered",
        answer: `${id} answer`,
        answeredAt,
        kind,
        options: jsonOptions(db, ["yes"]),
      });
    await answered("second", 2);
    await answered("first", 1);
    await answered("excluded", 3, "visual-review");
    const pending = () =>
      db.run((q) => pendingAnswerHandoffsSteps(q, "item", "session", ["visual-review"]));
    expect((await pending()).map((row) => row.id)).toEqual(["first", "second"]);
    const first = (await pending())[0]!;
    expect(first.body).toBe("first");
    expect(first.answer).toBe("first answer");
    expect(JSON.parse(first.options!)).toEqual(["yes"]);
    await db.run((q) => setQuestionHandoffVersionSteps(q, "first", 4));
    await db.run((q) => setRetryAnswerSteps(q, "second", "retry"));
    expect(await pending()).toEqual([]);
    const row = await db.run((q) =>
      q.one(q.orm.select().from(q.t.question).where(eq(q.t.question.id, "second"))),
    );
    expect(row).toMatchObject({ answer: "retry", handoffVersion: 0 });
  });

  test("an asked question stays open until answered", async () => {
    const db = await connect(open);
    await question(db, "open");
    await question(db, "answered", { status: "answered" });
    await db.run(function* (q) {
      yield* q.exec(
        q.orm.insert(q.t.workItemEvent).values({
          itemId: "item",
          version: 1,
          at: 1,
          fromState: "running",
          toState: "awaiting_input",
          event: "ask",
          kind: "ask",
          reason: "agent",
          payloadDigest: "open",
        }),
      );
    });
    expect(await db.run((q) => askedQuestionOpenSteps(q, "session", "open"))).toBe(true);
    expect(await db.run((q) => askedQuestionOpenSteps(q, "other", "open"))).toBe(false);
    expect(await db.run((q) => askedQuestionOpenSteps(q, "session", "answered"))).toBe(false);
  });
});

function jsonOptions(db: Db, options: unknown): never {
  return (db.dialect === "sqlite" ? JSON.stringify(options) : options) as never;
}

function jsonBrief(db: Db, brief: unknown): never {
  return (db.dialect === "sqlite" ? JSON.stringify(brief) : brief) as never;
}
