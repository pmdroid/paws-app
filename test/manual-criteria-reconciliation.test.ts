import { expect, test } from "bun:test";
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
  recordLinearInstallation,
} from "../src/db";
import { createItemReconciler, intakeDelegatedIssue } from "../src/intake";
import { createFakeLinearIssueLifecycle, createFakeTracker } from "../src/linear";
import { Orchestrator } from "../src/loop";
import {
  answerQuestion,
  ask,
  cancelItemQuestions,
  getQuestion,
  openLinkAsk,
  type QuestionKind,
} from "../src/questions";
import { workspaceAdmission } from "./fake-workspace";
import { tempDb, tempHome } from "./helpers";

test("criteria reconciliation preserves manual ownership and commits mixed siblings atomically", async () => {
  const db = tempDb();
  const clock = new FakeClock(1000);
  const orchestrator = new Orchestrator({
    db,
    admission: workspaceAdmission(db),
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: tempHome(),
    scheduling: () => ({}),
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
    db,
    tracker,
    lifecycle,
    now: () => clock.now(),
    onChanges: (changes) => orchestrator.applyDelegationChanges(changes),
  });
  try {
    const intake = await intakeDelegatedIssue(db, tracker, { linearIssueId: "parent", now: 1000 });
    expect(intake.ok).toBe(true);
    if (!intake.ok) return;
    db.run("INSERT INTO workspace VALUES('workspace','org','Workspace',1000)");
    recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "session",
      teamId: "team",
      observedAtMs: 1000,
    });
    bindLinearSessionTask(db, "session", intake.delegation.id, { actorId: "owner" });
    const ids = Object.fromEntries(intake.items.map((item) => [item.linearIssueId, item.id]));
    const manualId = ids.manual!;
    await reconciler.reconcile({ itemId: manualId, workspaceId: "workspace" });
    for (const state of states)
      db.run("UPDATE work_item SET state=?,version=7 WHERE id=?", [state, ids[state]!]);
    const obsolete: QuestionKind[] = ["plan-approval", "visual-review", "closeout-help", "ci-help"];
    const unrelated: QuestionKind[] = [
      "agent",
      "clarification",
      "repository",
      "runner-wait",
      "time-limit",
      "github-auth",
      "push-outage",
    ];
    const questions = [...obsolete, ...unrelated].map(
      (kind) =>
        ask(
          db,
          {
            itemId: manualId,
            runId: null,
            sessionId: "session",
          },
          kind,
          `Waiting for ${kind}`,
          { now: 1000 },
        ).question,
    );
    const links = (["bypass", "screenshots", "risk", "rounds", "rule", "question"] as const).map(
      (kind) =>
        openLinkAsk(db, {
          asker: { itemId: manualId, runId: null, sessionId: "session" },
          kind,
          head: "candidate",
          link: "https://paws.example.test/ask",
          detail: kind,
          answerers: ["owner"],
          now: 1000,
        }),
    );
    const original = getWorkItem(db, manualId)!;
    const notices = () =>
      listOutbox(db).filter((row) =>
        row.idempotencyKey.startsWith(`criteria-changed:${manualId}:`),
      );
    const jobs = () => db.query("SELECT * FROM job").all();
    const originalJobs = jobs();
    for (const child of tracker.epics.get("parent")!.subIssues)
      child.description = "Updated criteria";

    tracker.epics.get("parent")!.subIssues = tracker.epics
      .get("parent")!
      .subIssues.filter((child) => child.linearIssueId !== "removed");

    // An error after sibling changes must roll back briefs, questions, jobs and activities together.
    db.run(`CREATE TRIGGER fail_criteria_activity BEFORE INSERT ON outbox
      WHEN NEW.idempotency_key LIKE 'criteria-changed:${manualId}:%'
      BEGIN SELECT RAISE(ABORT, 'injected activity failure'); END`);
    await expect(
      reconciler.reconcile({ itemId: manualId, workspaceId: "workspace" }),
    ).rejects.toThrow("injected activity failure");
    expect(getWorkItem(db, manualId)).toEqual(original);
    expect(getWorkItem(db, ids.running!)!.state).toBe("running");
    expect(jobs()).toEqual(originalJobs);
    expect(getWorkItem(db, ids.removed!)!.state).toBe("queued");
    expect(questions.map((q) => getQuestion(db, q.id)!.cancelledAt)).toEqual(
      questions.map(() => null),
    );
    db.run("DROP TRIGGER fail_criteria_activity");

    await reconciler.reconcile({ itemId: manualId, workspaceId: "workspace" });
    expect(getWorkItem(db, manualId)).toEqual({
      ...original,
      brief: {
        ...original.brief!,
        issue: { ...original.brief!.issue, description: "Updated criteria" },
      },
    });
    expect(notices()).toHaveLength(1);
    expect(getWorkItem(db, ids.removed!)!.state).toBe("cancelled");
    expect((notices()[0]!.payload as { body: string }).body).toContain("manual");
    expect(
      db.query("SELECT 1 FROM job WHERE json_extract(payload,'$.itemId')=?").get(manualId),
    ).toBeNull();
    for (const question of questions) {
      if (obsolete.includes(question.kind)) {
        expect(getQuestion(db, question.id)!.status).toBe("cancelled");
        expect(
          answerQuestion(db, question.id, { answer: "approve", answeredBy: "owner" }),
        ).toBeNull();
      } else expect(getQuestion(db, question.id)!.cancelledAt).toBeNull();
    }
    expect(openLinkAsks(db, manualId).map((link) => link.kind)).toEqual(["question"]);
    for (const link of links) {
      const stored = getLinkAsk(db, link.question.id)!;
      expect(stored.closedAt).toBe(link.linkAsk.kind === "question" ? null : clock.now());
      expect(stored.closedReason).toBe(link.linkAsk.kind === "question" ? null : "cancelled");
      expect(getQuestion(db, link.question.id)!.cancelledAt === null).toBe(
        link.linkAsk.kind === "question",
      );
      if (link.linkAsk.kind !== "question")
        expect(
          answerQuestion(db, link.question.id, { answer: "approve", answeredBy: "owner" }),
        ).toBeNull();
    }
    for (const state of states) {
      const item = getWorkItem(db, ids[state]!)!;
      expect(item.brief!.issue.description).toBe("Updated criteria");
      expect(item.state).toBe(state === "running" || state === "failed" ? "queued" : state);
      if (["manual", "merged", "completed", "cancelled"].includes(state))
        expect(item.version).toBe(7);
      const resumeJobs = db
        .query("SELECT 1 FROM job WHERE queue='run.resume' AND json_extract(payload,'$.itemId')=?")
        .all(item.id);
      expect(resumeJobs).toHaveLength(state === "running" || state === "failed" ? 1 : 0);
    }
    const afterJobs = jobs();
    await reconciler.reconcile({ itemId: manualId, workspaceId: "workspace" });
    expect(notices()).toHaveLength(1);
    expect(jobs()).toEqual(afterJobs);
    // Another edit needs another activity even though manual ownership keeps version 7.
    tracker.epics
      .get("parent")!
      .subIssues.find((child) => child.linearIssueId === "manual")!.description =
      "Latest manual criteria";
    await reconciler.reconcile({ itemId: manualId, workspaceId: "workspace" });
    expect(getWorkItem(db, manualId)!.brief!.issue.description).toBe("Latest manual criteria");
    expect(getWorkItem(db, manualId)!.version).toBe(7);
    expect(notices()).toHaveLength(2);
    expect(jobs()).toEqual(afterJobs);
    advanceLinearSessionGeneration(db, "session", { now: clock.now() });
    enqueueOutbox(db, {
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
    expect(getWorkItem(db, manualId)!.brief!.issue.description).toBe("Criteria after PR");
    expect(notices()).toHaveLength(2);
    expect(transition("manual", "restart").ok).toBe(false);
    expect(transition("manual", "resume").ok).toBe(false);
  } finally {
    await reconciler.close();
    await orchestrator.shutdown();
    db.close();
  }
});

test.each(["all", "criteria"] as const)(
  "%s cancellation closes link asks and drops undelivered prompts atomically",
  (scope) => {
    const db = tempDb();
    try {
      const item = insertQueuedItem(db, {
        id: "EDIT-1",
        title: "Manual edit",
        sessionKey: "session",
      });
      const open = openLinkAsk(db, {
        asker: { itemId: item.id, runId: null, sessionId: "session" },
        kind: "risk",
        head: "candidate",
        link: "https://paws.example.test/risk",
        detail: "Approve candidate",
        answerers: ["owner"],
        now: 1000,
      });
      db.run("UPDATE outbox SET status='dead' WHERE op='elicitation'");
      const queued = openLinkAsk(db, {
        asker: { itemId: item.id, runId: null, sessionId: "session" },
        kind: "bypass",
        head: "candidate",
        link: "https://paws.example.test/bypass",
        detail: "Bypass candidate check",
        answerers: ["owner"],
        now: 1001,
      });
      expect(queued.question.status).toBe("queued");
      const before = listOutbox(db);
      expect(() =>
        db
          .transaction(() => {
            cancelItemQuestions(db, item.id, 1002, scope);
            throw new Error("rollback cleanup");
          })
          .immediate(),
      ).toThrow("rollback cleanup");
      expect(openLinkAsks(db, item.id)).toHaveLength(2);
      expect(getQuestion(db, open.question.id)!.status).toBe("open");
      expect(listOutbox(db)).toEqual(before);
      cancelItemQuestions(db, item.id, 1003, scope);
      expect(openLinkAsks(db, item.id)).toEqual([]);
      for (const { question } of [open, queued]) {
        expect(getLinkAsk(db, question.id)).toMatchObject({
          closedReason: "cancelled",
          closedAt: 1003,
        });
        expect(getQuestion(db, question.id)!.status).toBe("cancelled");
        expect(
          listOutbox(db).find(
            (row) => row.idempotencyKey === `link-ask-url-removed:${question.id}`,
          ),
        ).toBeDefined();
      }
      expect(
        listOutbox(db)
          .filter((row) => row.op === "elicitation")
          .map((row) => row.status),
      ).toEqual(["dropped"]);
      const after = listOutbox(db);
      cancelItemQuestions(db, item.id, 1004, scope);
      expect(listOutbox(db)).toEqual(after);
    } finally {
      db.close();
    }
  },
);
