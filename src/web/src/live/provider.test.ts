import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  applyWorkItemEvent,
  beginImplementRun,
  enqueueJob,
  enqueueOutbox,
  enterMergeQueue,
  insertQueuedItem,
  migrate,
  openDatabase,
} from "../../../db";
import { parseStatusSnapshot, statusIntegrity } from "../contract";
import { handleStatusRequest } from "../engine";
import { createLiveStatusProvider } from "./provider";

const open: Database[] = [];

afterEach(() => {
  for (const db of open) db.close();
  open.length = 0;
});

function database(): Database {
  const db = openDatabase(":memory:");
  migrate(db);
  open.push(db);
  return db;
}

describe("live status provider", () => {
  test("an empty database is a live snapshot with no items", async () => {
    const db = database();
    const response = await handleStatusRequest(new Request("http://127.0.0.1/api/status"), {
      db,
      env: {},
    });
    expect(response?.status).toBe(200);
    const body: unknown = await response?.json();
    const parsed = parseStatusSnapshot(body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.snapshot.source).toBe("live");
    expect(parsed.snapshot.items).toEqual([]);
    expect(parsed.snapshot.epics).toEqual([]);
    expect(parsed.snapshot.runs).toEqual([]);
    expect(parsed.snapshot.questions).toEqual([]);
    expect(parsed.snapshot.verdicts).toEqual([]);
    expect(parsed.snapshot.mergeQueue).toEqual([]);
    expect(statusIntegrity(parsed.snapshot)).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("Audit log export");
    expect(JSON.stringify(body)).not.toContain("acme");
  });

  test("reads items, runs, an open question, Closeout, and the merge queue", () => {
    const db = database();
    const now = 1_700_000_000_000;
    const base = "a".repeat(40);
    const head = "b".repeat(40);
    const waiting = insertQueuedItem(db, {
      id: "ENG-2",
      title: "Export rows",
      sessionKey: "ses_1",
      branchName: "paws/ENG-2",
      now,
    });
    const merging = insertQueuedItem(db, {
      id: "ENG-3",
      title: "Export the header",
      sessionKey: "ses_1",
      branchName: "paws/ENG-3",
      now,
    });
    const waitingRun = beginImplementRun(db, waiting.id, now);
    applyWorkItemEvent(db, waiting.id, "blocking_question");
    beginImplementRun(db, merging.id, now);
    enterMergeQueue(db, merging.id, { phase: "merge_queue", baseSha: base, wipCommit: head });
    const summary = [
      "Closeout: accepted",
      "Task: ENG-3",
      `Base: ${base}`,
      `Head: ${head}`,
      "Fix attempts: 1",
      "Evaluations: 2",
      "Exit: 0",
      "Items:",
      "- typecheck (command): passed — exited 0",
      "- adversarial-review (review): passed — no failing findings",
    ].join("\n");
    enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "ses_1",
      idempotencyKey: `${waitingRun.run.id}:first`,
      payload: { sessionId: "ses_1", kind: "thought", body: "Need a product decision." },
      now,
    });
    enqueueOutbox(db, {
      target: "linear",
      op: "elicitation",
      orderingKey: "ses_1",
      idempotencyKey: "ask:q-archived",
      payload: {
        sessionId: "ses_1",
        body: "Include archived rows?\n\nReply with one of the options, or answer in your own words.",
        options: ["yes", "no"],
      },
      now,
    });
    enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "ses_1",
      idempotencyKey: `${merging.id}:verdict:${head}:accepted`,
      payload: { sessionId: "ses_1", kind: "response", body: summary },
      now,
    });
    enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "ses_1",
      idempotencyKey: `${merging.id}:pr:7`,
      payload: {
        sessionId: "ses_1",
        kind: "response",
        body: "Opened https://github.com/pmdroid/paws-demo/pull/7.",
      },
      now,
    });
    enqueueJob(db, {
      queue: "github.merge",
      lane: "merge",
      jobKey: `merge:${merging.id}:${head}`,
      payload: { itemId: merging.id, summary: `${summary}\nCaller attempt: 2`, head },
      now,
    });

    const snapshot = createLiveStatusProvider(db, { now: () => new Date(now) }).snapshot();
    const parsed = parseStatusSnapshot(snapshot);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(statusIntegrity(parsed.snapshot)).toEqual([]);
    expect(parsed.snapshot.source).toBe("live");
    expect(parsed.snapshot.project.team).toBe("ENG");
    expect(parsed.snapshot.items.map((item) => [item.id, item.state])).toEqual([
      ["ENG-2", "awaiting_input"],
      ["ENG-3", "merge_queue"],
    ]);
    expect(parsed.snapshot.items.every((item) => item.blockers.length === 0)).toBe(true);
    expect(parsed.snapshot.runs.map((run) => run.itemId).sort()).toEqual(["ENG-2", "ENG-3"]);
    const parked = parsed.snapshot.runs.find((run) => run.itemId === "ENG-2");
    expect(parked?.state).toBe("awaiting_input");
    expect(parked?.agent).toBe("Cursor");
    expect(parked?.activity.some((line) => line.text === "Need a product decision.")).toBe(true);
    expect(parsed.snapshot.questions).toEqual([
      expect.objectContaining({
        id: "q-archived",
        itemId: "ENG-2",
        title: "Include archived rows?",
        options: ["yes", "no"],
        kind: "decision",
        urgency: "blocking",
      }),
    ]);
    const verdict = parsed.snapshot.verdicts.find((entry) => entry.itemId === "ENG-3");
    expect(verdict?.decision).toBe("accepted");
    expect(verdict?.baseSha).toBe(base);
    expect(verdict?.headSha).toBe(head);
    expect(verdict?.checks.map((check) => [check.id, check.kind, check.state])).toEqual([
      ["typecheck", "command", "passed"],
      ["adversarial-review", "review", "passed"],
    ]);
    expect(parsed.snapshot.mergeQueue).toEqual([
      expect.objectContaining({ position: 1, itemId: "ENG-3" }),
    ]);
    expect(parsed.snapshot.items.find((item) => item.id === "ENG-3")?.pr).toEqual({
      number: 7,
      url: "https://github.com/pmdroid/paws-demo/pull/7",
    });
    expect(JSON.stringify(snapshot)).not.toContain("Audit log export");
  });

  test("demo is opt-in and does not replace a live database unless asked", async () => {
    const db = database();
    insertQueuedItem(db, { id: "ENG-9", title: "Hang", now: 1 });
    const live = await handleStatusRequest(new Request("http://127.0.0.1/api/status"), {
      db,
      env: {},
    });
    const liveBody = (await live?.json()) as { source: string; items: Array<{ id: string }> };
    expect(liveBody.source).toBe("live");
    expect(liveBody.items.map((item) => item.id)).toEqual(["ENG-9"]);

    const query = await handleStatusRequest(
      new Request("http://127.0.0.1/api/status?engine=demo"),
      { db, env: {} },
    );
    const queryBody = (await query?.json()) as { source: string; items: Array<{ id: string }> };
    expect(queryBody.source).toBe("demo");
    expect(queryBody.items.some((item) => item.id === "ENG-9")).toBe(false);

    const flagged = await handleStatusRequest(new Request("http://127.0.0.1/api/status"), {
      db,
      env: { PAWS_STATUS_DEMO: "1" },
    });
    const flaggedBody = (await flagged?.json()) as { source: string };
    expect(flaggedBody.source).toBe("demo");
  });
});
