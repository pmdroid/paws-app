import { expect, test } from "bun:test";
import { FakeClock, transition } from "../src/core";
import {
  bindLinearSessionTask,
  getWorkItem,
  JobLoop,
  listOutbox,
  OutboxDispatcher,
  recordLinearInstallation,
} from "../src/db";
import { createItemReconciler, intakeDelegatedIssue } from "../src/intake";
import { createFakeLinearIssueLifecycle, createFakeTracker } from "../src/linear";
import { Orchestrator } from "../src/loop";
import { answerQuestion, ask, getQuestion, openLinkAsk, type QuestionKind } from "../src/questions";
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
    for (const link of links) {
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
    expect(transition("manual", "restart").ok).toBe(false);
    expect(transition("manual", "resume").ok).toBe(false);
  } finally {
    await reconciler.close();
    await orchestrator.shutdown();
    db.close();
  }
});
