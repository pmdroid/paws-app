import { expect, test } from "bun:test";
import { eq, sql, type SQL } from "drizzle-orm";
import { FakeClock, transition } from "../src/core";
import {
  bindLinearSessionTask,
  advanceLinearSessionGeneration,
  getWorkItem,
  getLinkAsk,
  insertQueuedItem,
  openLinkAsks,
  enqueueOutbox,
  JobLoop,
  listOutbox,
  OutboxDispatcher,
  listJobs,
  recordLinearInstallation,
  type Db,
  type PgDb,
} from "../src/db";
import { createItemReconciler, intakeDelegatedIssue } from "../src/intake";
import { createFakeLinearIssueLifecycle, createFakeTracker } from "../src/linear";
import { Orchestrator } from "../src/loop";
import {
  cancelItemQuestionsSteps,
  getQuestion,
  openLinkAsk,
  type QuestionKind,
  type StoredQuestion,
} from "../src/questions";
import { answerQuestionPg, askPg } from "./questions";
import { workspaceAdmission } from "./fake-workspace";
import { seed } from "./dialects";
import { tempHome } from "./helpers";
import { tempStore } from "./pglite";

const execute = (db: Db, query: SQL) => (db as PgDb).orm.execute(query);

const jobsFor = async (db: Db, itemId: string, queue?: string) =>
  (await listJobs(db)).filter(
    (job) =>
      (job.payload as { itemId?: unknown } | null)?.itemId === itemId &&
      (queue === undefined || job.queue === queue),
  );

test("criteria reconciliation preserves manual ownership and commits mixed siblings atomically", async () => {
  const { db, close } = await tempStore();
  const clock = new FakeClock(1000);
  const orchestrator = new Orchestrator({
    store: db,
    admission: workspaceAdmission(db),
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: tempHome(),
    scheduling: async () => ({}),
  });
  const states = [
    "running",
    "manual",
    "paused",
    "failed",
    "merged",
    "completed",
    "cancelled",
  ] as const;
  const tracker = createFakeTracker([
    {
      linearIssueId: "parent",
      identifier: "EDIT-1",
      title: "Parent",
      description: "Criteria",
      subIssues: [...states, "removed"].map((state) => ({
        linearIssueId: state,
        identifier: `EDIT-${state}`,
        title: state,
        description: "Original",
      })),
    },
  ]);
  const lifecycle = createFakeLinearIssueLifecycle({
    id: "parent",
    teamId: "team",
    stateType: "started",
    assigneeId: null,
    delegateId: "app",
  });
  for (const state of [...states, "removed"])
    lifecycle.issues.set(state, { ...lifecycle.issue, id: state });
  const reconciler = createItemReconciler({
    store: db,
    tracker,
    lifecycle,
    now: () => clock.now(),
    onChanges: (q, changes) => orchestrator.applyDelegationChangesSteps(q, changes),
  });
  try {
    const intake = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      now: 1000,
    });
    expect(intake.ok).toBe(true);
    if (!intake.ok) return;
    await seed(db, (q) =>
      q.orm.insert(q.t.workspace).values({
        id: "workspace",
        linearOrganizationId: "org",
        name: "Workspace",
        createdAt: 1000,
      }),
    );
    await recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "session",
      teamId: "team",
      observedAtMs: 1000,
    });
    await bindLinearSessionTask(db, "session", intake.delegation.id, {
      actorId: "owner",
    });
    const ids = Object.fromEntries(intake.items.map((item) => [item.linearIssueId, item.id]));
    const manualId = ids.manual!;
    await reconciler.reconcile({ itemId: manualId, workspaceId: "workspace" });
    for (const state of states)
      await seed(db, (q) =>
        q.orm
          .update(q.t.workItem)
          .set({ state, version: 7 })
          .where(eq(q.t.workItem.id, ids[state]!)),
      );
    const obsolete: QuestionKind[] = ["plan-approval", "visual-review", "closeout-help", "ci-help"];
    const unrelated: QuestionKind[] = [
      "agent",
      "clarification",
      "repository",
      "runner-wait",
      "time-limit",
      "github-auth",
      "push-outage",
      "policy-outage",
    ];
    const questions: StoredQuestion[] = [];
    for (const kind of [...obsolete, ...unrelated])
      questions.push(
        (
          await askPg(
            db,
            {
              itemId: manualId,
              runId: null,
              sessionId: "session",
            },
            kind,
            `Waiting for ${kind}`,
            { now: 1000 },
          )
        ).question,
      );
    const links: Awaited<ReturnType<typeof openLinkAsk>>[] = [];
    for (const kind of ["bypass", "screenshots", "risk", "rounds", "rule", "question"] as const)
      links.push(
        await openLinkAsk(db, {
          asker: { itemId: manualId, runId: null, sessionId: "session" },
          kind,
          head: "candidate",
          link: "https://paws.example.test/ask",
          detail: kind,
          answerers: ["owner"],
          now: 1000,
        }),
      );
    const original = (await getWorkItem(db, manualId))!;
    const notices = async () =>
      (await listOutbox(db)).filter((row) =>
        row.idempotencyKey.startsWith(`criteria-changed:${manualId}:`),
      );
    const jobs = () => listJobs(db);
    const originalJobs = await jobs();
    for (const child of tracker.epics.get("parent")!.subIssues)
      child.description = "Updated criteria";

    tracker.epics.get("parent")!.subIssues = tracker.epics
      .get("parent")!
      .subIssues.filter((child) => child.linearIssueId !== "removed");

    // An error after sibling changes must roll back briefs, questions, jobs and activities together.
    await execute(
      db,
      sql`CREATE FUNCTION fail_criteria_activity() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected activity failure'; END $$ LANGUAGE plpgsql`,
    );
    await execute(
      db,
      sql.raw(
        `CREATE TRIGGER fail_criteria_activity BEFORE INSERT ON outbox FOR EACH ROW WHEN (NEW.idempotency_key LIKE 'criteria-changed:${manualId}:%') EXECUTE FUNCTION fail_criteria_activity()`,
      ),
    );
    const failure = (await reconciler
      .reconcile({ itemId: manualId, workspaceId: "workspace" })
      .catch((error: unknown) => error)) as Error;
    expect(String(failure.cause)).toContain("injected activity failure");
    expect(await getWorkItem(db, manualId)).toEqual(original);
    expect((await getWorkItem(db, ids.running!))!.state).toBe("running");
    expect(await jobs()).toEqual(originalJobs);
    expect((await getWorkItem(db, ids.removed!))!.state).toBe("queued");
    expect(
      await Promise.all(questions.map(async (q) => (await getQuestion(db, q.id))!.cancelledAt)),
    ).toEqual(questions.map(() => null));
    await execute(db, sql`DROP TRIGGER fail_criteria_activity ON outbox`);

    await reconciler.reconcile({ itemId: manualId, workspaceId: "workspace" });
    expect(await getWorkItem(db, manualId)).toEqual({
      ...original,
      brief: {
        ...original.brief!,
        issue: { ...original.brief!.issue, description: "Updated criteria" },
      },
    });
    expect(await notices()).toHaveLength(1);
    expect((await getWorkItem(db, ids.removed!))!.state).toBe("cancelled");
    expect(((await notices())[0]!.payload as { body: string }).body).toContain("manual");
    expect(await jobsFor(db, manualId)).toEqual([]);
    for (const question of questions) {
      if (obsolete.includes(question.kind)) {
        expect((await getQuestion(db, question.id))!.status).toBe("cancelled");
        expect(
          await answerQuestionPg(db, question.id, { answer: "approve", answeredBy: "owner" }),
        ).toBeNull();
      } else expect((await getQuestion(db, question.id))!.cancelledAt).toBeNull();
    }
    expect((await openLinkAsks(db, manualId)).map((link) => link.kind)).toEqual(["question"]);
    for (const link of links) {
      const stored = (await getLinkAsk(db, link.question.id))!;
      expect(stored.closedAt).toBe(link.linkAsk.kind === "question" ? null : clock.now());
      expect(stored.closedReason).toBe(link.linkAsk.kind === "question" ? null : "cancelled");
      expect((await getQuestion(db, link.question.id))!.cancelledAt === null).toBe(
        link.linkAsk.kind === "question",
      );
      if (link.linkAsk.kind !== "question")
        expect(
          await answerQuestionPg(db, link.question.id, { answer: "approve", answeredBy: "owner" }),
        ).toBeNull();
    }
    for (const state of states) {
      const item = (await getWorkItem(db, ids[state]!))!;
      expect(item.brief!.issue.description).toBe("Updated criteria");
      expect(item.state).toBe(state === "running" || state === "failed" ? "queued" : state);
      if (["manual", "merged", "completed", "cancelled"].includes(state))
        expect(item.version).toBe(7);
      const resumeJobs = await jobsFor(db, item.id, "run.resume");
      expect(resumeJobs).toHaveLength(state === "running" || state === "failed" ? 1 : 0);
    }
    const afterJobs = await jobs();
    await reconciler.reconcile({ itemId: manualId, workspaceId: "workspace" });
    expect(await notices()).toHaveLength(1);
    expect(await jobs()).toEqual(afterJobs);
    // Another edit needs another activity even though manual ownership keeps version 7.
    tracker.epics
      .get("parent")!
      .subIssues.find((child) => child.linearIssueId === "manual")!.description =
      "Latest manual criteria";
    await reconciler.reconcile({ itemId: manualId, workspaceId: "workspace" });
    expect((await getWorkItem(db, manualId))!.brief!.issue.description).toBe(
      "Latest manual criteria",
    );
    expect((await getWorkItem(db, manualId))!.version).toBe(7);
    expect(await notices()).toHaveLength(2);
    expect(await jobs()).toEqual(afterJobs);
    await advanceLinearSessionGeneration(db, "session", { now: clock.now() });
    await enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "session",
      idempotencyKey: `pull-request-ready:${manualId}:0`,
      payload: { sessionId: "session", kind: "response", body: "Opened PR" },
      now: clock.now(),
    });
    tracker.epics
      .get("parent")!
      .subIssues.find((child) => child.linearIssueId === "manual")!.description =
      "Criteria after PR";
    await reconciler.reconcile({ itemId: manualId, workspaceId: "workspace" });
    expect((await getWorkItem(db, manualId))!.brief!.issue.description).toBe("Criteria after PR");
    expect(await notices()).toHaveLength(2);
    expect(transition("manual", "restart").ok).toBe(false);
    expect(transition("manual", "resume").ok).toBe(false);
  } finally {
    await reconciler.close();
    await orchestrator.shutdown();
    await close();
  }
});

test.each(["all", "criteria"] as const)(
  "%s cancellation closes link asks and drops undelivered prompts atomically",
  async (scope) => {
    const { db, close } = await tempStore();
    try {
      const item = await insertQueuedItem(db, {
        id: "EDIT-1",
        title: "Manual edit",
        sessionKey: "session",
      });
      const open = await openLinkAsk(db, {
        asker: { itemId: item.id, runId: null, sessionId: "session" },
        kind: "risk",
        head: "candidate",
        link: "https://paws.example.test/risk",
        detail: "Approve candidate",
        answerers: ["owner"],
        now: 1000,
      });
      await seed(db, (q) =>
        q.orm.update(q.t.outbox).set({ status: "dead" }).where(eq(q.t.outbox.op, "elicitation")),
      );
      const queued = await openLinkAsk(db, {
        asker: { itemId: item.id, runId: null, sessionId: "session" },
        kind: "bypass",
        head: "candidate",
        link: "https://paws.example.test/bypass",
        detail: "Bypass candidate check",
        answerers: ["owner"],
        now: 1001,
      });
      expect(queued.question.status).toBe("queued");
      const before = await listOutbox(db);
      await expect(
        db.transaction(function* (q) {
          yield* cancelItemQuestionsSteps(q, item.id, 1002, scope);
          throw new Error("rollback cleanup");
        }),
      ).rejects.toThrow("rollback cleanup");
      expect(await openLinkAsks(db, item.id)).toHaveLength(2);
      expect((await getQuestion(db, open.question.id))!.status).toBe("open");
      expect(await listOutbox(db)).toEqual(before);
      await db.transaction((q) => cancelItemQuestionsSteps(q, item.id, 1003, scope));
      expect(await openLinkAsks(db, item.id)).toEqual([]);
      for (const { question } of [open, queued]) {
        expect(await getLinkAsk(db, question.id)).toMatchObject({
          closedReason: "cancelled",
          closedAt: 1003,
        });
        expect((await getQuestion(db, question.id))!.status).toBe("cancelled");
        expect(
          (await listOutbox(db)).find(
            (row) => row.idempotencyKey === `link-ask-url-removed:${question.id}`,
          ),
        ).toBeDefined();
      }
      expect(
        (await listOutbox(db)).filter((row) => row.op === "elicitation").map((row) => row.status),
      ).toEqual(["dropped"]);
      const after = await listOutbox(db);
      await db.transaction((q) => cancelItemQuestionsSteps(q, item.id, 1004, scope));
      expect(await listOutbox(db)).toEqual(after);
    } finally {
      await close();
    }
  },
);
