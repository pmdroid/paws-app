import { expect, test } from "bun:test";
import {
  applyLinearTurns,
  beginImplementRun,
  enqueueOutbox,
  insertQueuedItem,
  insertRun,
  markRun,
  migrate,
  openDatabase,
  recordLinearTurn,
  setCurrentRun,
} from "../src/db";
import { handleStatusRequest } from "../src/web";
import { render } from "../src/web/src/client/render";
import { parseStatusItemDetail, parseStatusSnapshot } from "../src/web/src/contract";
import { parseRoute } from "../src/web/src/client/route";

const NOW = 1_700_000_000_000;

test("one Linear session shows as one run with every attempt in its timeline", async () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db);
    const item = insertQueuedItem(db, {
      id: "01SESSIONITEM",
      title: "Runs list filters",
      sessionKey: "ses_7",
      branchName: "paws/eng-7",
      now: NOW,
    });
    db.run("UPDATE work_item SET linear_identifier = ? WHERE id = ?", ["ENG-7", item.id]);
    const { run: first } = beginImplementRun(db, item.id, NOW);
    markRun(db, first.id, "ended", NOW + 1_000);
    const review = insertRun(db, {
      itemId: item.id,
      kind: "review",
      agent: "grok",
      status: "ended",
      now: NOW + 2_000,
    });
    const reply = insertRun(db, {
      itemId: item.id,
      kind: "implement",
      agent: "claude",
      status: "active",
      now: NOW + 3_000,
    });
    setCurrentRun(db, item.id, reply.id);
    for (const [runId, at, body] of [
      [first.id, NOW + 500, "Wrote the filters."],
      [review.id, NOW + 2_500, "Review found one issue."],
      [reply.id, NOW + 3_500, "Fixed the issue."],
    ] as const)
      enqueueOutbox(db, {
        target: "linear",
        op: "activity",
        orderingKey: "ses_7",
        idempotencyKey: `${runId}:thought`,
        payload: { sessionId: "ses_7", kind: "thought", body },
        now: at,
      });

    const response = await handleStatusRequest(new Request("http://127.0.0.1/api/status"), {
      db,
      env: {},
    });
    const parsed = parseStatusSnapshot(await response?.json());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const runs = parsed.snapshot.runs.filter((run) => run.itemId === "ENG-7");
    expect(runs).toHaveLength(1);
    const session = runs[0]!;
    expect(session.id).toBe(first.id);
    expect(session.attempts).toEqual([first.id, review.id, reply.id]);
    expect(session.agent).toBe("Claude");
    const texts = session.activity.map((line) => line.text);
    expect(texts.indexOf("Wrote the filters.")).toBeLessThan(
      texts.indexOf("Review started with Grok."),
    );
    expect(texts.indexOf("Review started with Grok.")).toBeLessThan(
      texts.indexOf("Review found one issue."),
    );
    expect(texts.indexOf("Review found one issue.")).toBeLessThan(
      texts.indexOf("Fixed the issue."),
    );
    expect(parsed.snapshot.items.find((entry) => entry.id === "ENG-7")?.runId).toBe(first.id);

    // A run link opens the issue page, which loads that issue's detail.
    const route = parseRoute(`/runs/${review.id}`, parsed.snapshot);
    expect(route).toEqual({ view: "issues", id: "ENG-7" });
    const itemResponse = await handleStatusRequest(
      new Request("http://127.0.0.1/api/status/items/ENG-7"),
      {
        db,
        env: {},
      },
    );
    const detail = parseStatusItemDetail(await itemResponse?.json());
    if (!detail.ok) throw new Error(detail.error);
    const page = render({
      route: route!,
      phase: "ready",
      snapshot: parsed.snapshot,
      detail: detail.detail,
      error: null,
      engineUrl: null,
    });
    // A run link opens the issue page, which names the task only as ENG-7.
    expect(page.content).toContain('<span class="lin-id">ENG-7</span> Runs list filters</h1>');
    expect(page.content).not.toContain("Run not found");
    expect(page.content.replace(/<[^>]*>/g, " ")).not.toContain(first.id);
  } finally {
    db.close();
  }
});

test("a reply in the Linear session shows in the run's timeline with its author, without its text", async () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db);
    const item = insertQueuedItem(db, {
      id: "01REPLYITEM",
      title: "Retry Closeout",
      sessionKey: "ses_8",
      branchName: "paws/eng-8",
      now: NOW,
    });
    db.run("UPDATE work_item SET linear_identifier = ? WHERE id = ?", ["ENG-8", item.id]);
    const { run } = beginImplementRun(db, item.id, NOW);
    for (const [at, body] of [
      [NOW + 500, "Closeout needs your help."],
      [NOW + 2_500, "Running Closeout again."],
    ] as const)
      enqueueOutbox(db, {
        target: "linear",
        op: "activity",
        orderingKey: "ses_8",
        idempotencyKey: `${run.id}:${at}`,
        payload: { sessionId: "ses_8", kind: "thought", body },
        now: at,
      });
    recordLinearTurn(db, {
      eventKey: "reply-1",
      activityId: null,
      sessionId: "ses_8",
      actorId: "linear-user",
      body: "retry",
      payload: JSON.stringify({ agentActivity: { user: { name: "Pascal" } } }),
      createdAtMs: NOW + 1_500,
      now: NOW + 1_500,
    });
    applyLinearTurns(db, "ses_8", ["reply-1"], item.id);

    const response = await handleStatusRequest(new Request("http://127.0.0.1/api/status"), {
      db,
      env: {},
    });
    const parsed = parseStatusSnapshot(await response?.json());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const lines = parsed.snapshot.runs.find((entry) => entry.itemId === "ENG-8")!.activity;
    expect(lines.map((line) => [line.kind, line.text])).toEqual([
      ["system", "Implementation started with Cursor."],
      ["thought", "Closeout needs your help."],
      ["prompt", "Pascal replied."],
      ["thought", "Running Closeout again."],
    ]);
  } finally {
    db.close();
  }
});

test("a Closeout re-check shows as a re-check, not as a review by the reviewer agent", async () => {
  const db = openDatabase(":memory:");
  try {
    migrate(db);
    const item = insertQueuedItem(db, { id: "01RECHECKITEM", sessionKey: "ses_8", now: NOW });
    db.run("UPDATE work_item SET linear_identifier = ? WHERE id = ?", ["ENG-8", item.id]);
    const { run: first } = beginImplementRun(db, item.id, NOW);
    markRun(db, first.id, "ended", NOW + 1_000);
    const recheck = insertRun(db, {
      itemId: item.id,
      kind: "recheck",
      agent: "claude",
      status: "active",
      now: NOW + 2_000,
    });
    setCurrentRun(db, item.id, recheck.id);
    const response = await handleStatusRequest(new Request("http://127.0.0.1/api/status"), {
      db,
      env: {},
    });
    const parsed = parseStatusSnapshot(await response?.json());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const session = parsed.snapshot.runs.find((run) => run.itemId === "ENG-8")!;
    const texts = session.activity.map((line) => line.text);
    expect(texts).toContain("Closeout re-check started.");
    expect(texts.some((text) => text.startsWith("Review started"))).toBe(false);
    expect(session.agent).toBe("Claude");
  } finally {
    db.close();
  }
});
