import { expect, test } from "bun:test";
import {
  beginImplementRun,
  enqueueOutbox,
  insertQueuedItem,
  insertRun,
  markRun,
  migrate,
  openDatabase,
  setCurrentRun,
} from "../src/db";
import { handleStatusRequest } from "../src/web";
import { render } from "../src/web/src/client/render";
import { parseStatusSnapshot } from "../src/web/src/contract";

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

    const page = render({
      route: { view: "runs", id: review.id },
      phase: "ready",
      snapshot: parsed.snapshot,
      via: "engine",
      error: null,
      engineUrl: null,
    });
    expect(page.content).toContain(`Run ${first.id}`);
    expect(page.content).not.toContain("Run not found");
  } finally {
    db.close();
  }
});
