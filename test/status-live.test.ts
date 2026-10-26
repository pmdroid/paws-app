import { expect, test } from "bun:test";
import { formatEvidenceSummary } from "../src/closeout";
import {
  applyWorkItemEvent,
  beginImplementRun,
  countLinearRequest,
  enqueueJob,
  enqueueOutbox,
  enterMergeQueue,
  joinMergeQueue,
  getWorkItem,
  insertQueuedItem,
  migrate,
  openDatabase,
  putWorkspaceUser,
  saveTaskBlocks,
  saveWorkItemLinearProject,
} from "../src/db";
import { elicitationBody, openQuestion } from "../src/questions";
import { parseStatusSnapshot, statusIntegrity } from "../src/web/src/contract";
import { render } from "../src/web/src/client/render";
import { handleStatusRequest } from "../src/web";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const NOW = 1_700_000_000_000;

test("fake e2e rows show up on /api/status as live work", async () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db);
    const waiting = insertQueuedItem(db, {
      id: "01WAITINGITEM",
      title: "Export rows",
      sessionKey: "ses_1",
      branchName: "paws/ENG-2",
      now: NOW,
    });
    const merging = insertQueuedItem(db, {
      id: "01MERGINGITEM",
      title: "Export the header",
      sessionKey: "ses_1",
      branchName: "paws/ENG-3",
      now: NOW,
    });
    db.run("UPDATE work_item SET linear_identifier = ? WHERE id = ?", ["ENG-2", waiting.id]);
    db.run("UPDATE work_item SET linear_identifier = ? WHERE id = ?", ["ENG-3", merging.id]);
    db.run(
      "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('ws','org','Workspace',0)",
    );
    const userId = putWorkspaceUser(db, {
      id: "user",
      linearUserId: "linear-user",
      name: "Ada Owner",
      email: "ada@example.test",
    });
    db.run("UPDATE work_item SET owner_user_id = ? WHERE id = ?", [userId, waiting.id]);
    saveWorkItemLinearProject(db, waiting.id, { id: "linear-exports", name: "Exports" });
    saveTaskBlocks(
      db,
      [merging.linearIssueId],
      [
        {
          blockerLinearIssueId: waiting.linearIssueId,
          blockedLinearIssueId: merging.linearIssueId,
        },
      ],
    );

    const parked = beginImplementRun(db, waiting.id, NOW);
    applyWorkItemEvent(db, waiting.id, "blocking_question");
    beginImplementRun(db, merging.id, NOW);
    enterMergeQueue(db, merging.id, { phase: "merge_queue", baseSha: BASE, wipCommit: HEAD });
    joinMergeQueue(db, { itemId: merging.id, repository: "pmdroid/paws-demo", now: 1 });
    const open = getWorkItem(db, waiting.id);
    expect(open?.state).toBe("awaiting_input");
    const question = openQuestion(db, {
      itemId: waiting.id,
      runId: parked.run.id,
      sessionId: "ses_1",
      body: "Include archived rows?",
      options: ["yes", "no"],
      now: NOW,
    });
    enqueueOutbox(db, {
      target: "linear",
      op: "elicitation",
      orderingKey: "ses_1",
      idempotencyKey: `ask:${question.id}`,
      payload: {
        sessionId: "ses_1",
        body: elicitationBody("Include archived rows?"),
        options: ["yes", "no"],
      },
      now: NOW,
    });
    enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "ses_1",
      idempotencyKey: `${parked.run.id}:thought`,
      payload: { sessionId: "ses_1", kind: "thought", body: "Need a product decision." },
      now: NOW,
    });
    const summary = formatEvidenceSummary({
      outcome: "accepted",
      taskId: "ENG-3",
      base: BASE,
      head: HEAD,
      fixAttempts: 1,
      evaluations: 2,
      exitCode: 0,
      decision: {
        specVersion: "0.1",
        decision: "accepted",
        gate: "beforePR",
        base: BASE,
        head: HEAD,
        message: "fresh evidence",
        candidate: {
          task: "ENG-3",
          session: "impl-session",
          model: "claude",
          provider: "anthropic",
        },
        policy: { path: ".agents/closeout.yaml", digest: null, absent: false },
        items: [
          { id: "typecheck", kind: "command", state: "passed", message: "exited 0" },
          {
            id: "adversarial-review",
            kind: "review",
            state: "passed",
            message: "no failing findings",
          },
        ],
        warnings: [],
      },
    });
    enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "ses_1",
      idempotencyKey: `${merging.id}:verdict:${HEAD}:accepted`,
      payload: { sessionId: "ses_1", kind: "response", body: summary },
      now: NOW,
    });
    enqueueJob(db, {
      queue: "github.merge",
      lane: "merge",
      jobKey: `merge:${merging.id}:${HEAD}`,
      payload: { itemId: merging.id, summary: `${summary}\nCaller attempt: 2`, head: HEAD },
      now: NOW,
    });
    enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "ses_1",
      idempotencyKey: `${merging.id}:pr:4`,
      payload: {
        sessionId: "ses_1",
        kind: "response",
        body: "Opened https://github.com/pmdroid/paws-demo/pull/4.",
      },
      now: NOW,
    });

    const response = await handleStatusRequest(new Request("http://127.0.0.1/api/status"), {
      db,
      env: {},
    });
    expect(response?.status).toBe(200);
    const body: unknown = await response?.json();
    const parsed = parseStatusSnapshot(body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(statusIntegrity(parsed.snapshot)).toEqual([]);
    expect(parsed.snapshot.source).toBe("live");
    expect(JSON.stringify(body)).not.toContain("Audit log export");
    expect(parsed.snapshot.items.map((item) => item.id)).not.toContain("01WAITINGITEM");
    expect(parsed.snapshot.runs.map((run) => run.itemId)).not.toContain("01MERGINGITEM");

    const rows = parsed.snapshot.items.map((item) => [
      item.id,
      item.state,
      item.owner,
      item.project,
    ]);
    expect(rows).toEqual([
      ["ENG-2", "awaiting_input", "Ada Owner", { id: "linear-exports", name: "Exports" }],
      ["ENG-3", "merge_queue", null, null],
    ]);
    expect(parsed.snapshot.items.find((item) => item.id === "ENG-2")?.blockers).toEqual([]);
    expect(parsed.snapshot.items.find((item) => item.id === "ENG-3")?.blockers).toEqual(["ENG-2"]);

    const parkedRun = parsed.snapshot.runs.find((run) => run.itemId === "ENG-2");
    expect(parkedRun?.state).toBe("awaiting_input");
    expect(parkedRun?.activity.some((line) => line.text === "Need a product decision.")).toBe(true);
    expect(parsed.snapshot.runs.some((run) => run.itemId === "ENG-3")).toBe(true);

    expect(parsed.snapshot.questions.map((entry) => entry.title)).toEqual([
      "Include archived rows?",
    ]);
    expect(parsed.snapshot.questions[0]?.itemId).toBe("ENG-2");
    expect(parsed.snapshot.questions[0]?.options).toEqual(["yes", "no"]);
    expect(parsed.snapshot.questions[0]?.runId).toBe(parked.run.id);

    const verdict = parsed.snapshot.verdicts.find((entry) => entry.itemId === "ENG-3");
    expect(verdict?.decision).toBe("accepted");
    expect(verdict?.checks.map((check) => check.id)).toEqual(["typecheck", "adversarial-review"]);
    expect(verdict?.headSha).toBe(HEAD);

    expect(
      parsed.snapshot.mergeQueue.map((entry) => [entry.position, entry.itemId, entry.repository]),
    ).toEqual([[1, "ENG-3", "pmdroid/paws-demo"]]);
    expect(parsed.snapshot.items.find((item) => item.id === "ENG-3")?.pr?.number).toBe(4);

    const hidden = await handleStatusRequest(
      new Request("http://127.0.0.1/api/status?engine=demo"),
      { db, env: {} },
    );
    const demo = (await hidden?.json()) as { source: string };
    expect(demo.source).toBe("live");
  } finally {
    db.close();
  }
});

test("each task on /api/status carries the Linear requests it made", async () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db);
    insertQueuedItem(db, { id: "item-1", sessionKey: "ses_1", now: NOW });
    insertQueuedItem(db, { id: "item-2", sessionKey: "ses_2", now: NOW });
    for (let request = 0; request < 3; request++) countLinearRequest(db, "item-1", "outbox");
    const response = await handleStatusRequest(new Request("http://127.0.0.1/api/status"), {
      db,
      env: {},
    });
    const parsed = parseStatusSnapshot(await response?.json());
    if (!parsed.ok) throw new Error(parsed.error);
    expect(
      Object.fromEntries(parsed.snapshot.items.map((item) => [item.id, item.linearRequests])),
    ).toEqual({ "item-1": 3, "item-2": 0 });
  } finally {
    db.close();
  }
});

test("an empty live snapshot asks the operator to delegate a Linear issue", async () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db);
    const response = await handleStatusRequest(new Request("http://127.0.0.1/api/status"), {
      db,
      env: {},
    });
    const parsed = parseStatusSnapshot(await response?.json());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const view = render({
      route: { view: "overview" },
      phase: "ready",
      snapshot: parsed.snapshot,
      error: null,
      engineUrl: "http://127.0.0.1:8787",
    });
    expect(parsed.snapshot.source).toBe("live");
    expect(parsed.snapshot.items).toEqual([]);
    expect(view.top).not.toContain("Live");
    expect(view.top).not.toContain("Demo data");
    expect(view.content).toContain("No issues yet. Delegate an issue to Paws in Linear.");
  } finally {
    db.close();
  }
});
