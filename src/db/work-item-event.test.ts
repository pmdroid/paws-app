import { afterEach, describe, expect, test } from "bun:test";
import {
  applyWorkItemEventSteps,
  applyWorkItemEvent,
  getWorkItem,
  insertQueuedItem,
  listWorkItemEventRows,
  TransitionRejectedError,
} from "./index";
import { seed } from "../../test/dialects";
import { tempStore } from "../../test/pglite";

const closes: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closes.splice(0).map((close) => close()));
});

async function harness() {
  const { db, close } = await tempStore();
  closes.push(close);
  const item = await insertQueuedItem(db, { id: "eng-1", sessionKey: "ses", now: 1_000 });
  return { db, item };
}

describe("work_item_event", () => {
  test("each committed transition writes one row with the version it produced", async () => {
    const { db, item } = await harness();
    const running = await applyWorkItemEvent(db, item.id, "dispatched", { now: 2_000 });
    await applyWorkItemEvent(db, item.id, "restart", {
      kind: "restart",
      reason: "findings",
      payloadDigest: "sha256:abc",
      actor: "paws",
      now: 3_000,
    });
    await applyWorkItemEvent(db, item.id, "dispatched", { now: 4_000 });
    await applyWorkItemEvent(db, item.id, "blocking_question", {
      kind: "ask",
      reason: "budget_spent",
      now: 5_000,
    });

    const rows = await listWorkItemEventRows(db, item.id);
    expect(
      rows.map((row) => [row.fromState, row.event, row.toState, row.kind, row.reason]),
    ).toEqual([
      ["queued", "dispatched", "running", "transition", null],
      ["running", "restart", "queued", "restart", "findings"],
      ["queued", "dispatched", "running", "transition", null],
      ["running", "blocking_question", "awaiting_input", "ask", "budget_spent"],
    ]);
    expect(rows[0]).toMatchObject({ version: running.version, at: 2_000, actor: null });
    expect(rows[1]).toMatchObject({ payloadDigest: "sha256:abc", actor: "paws", at: 3_000 });
    expect(rows.at(-1)?.version).toBe((await getWorkItem(db, item.id))?.version);
  });

  test("a rolled-back transition leaves no event row and no state change", async () => {
    const { db, item } = await harness();
    await expect(
      db.transaction(function* (q) {
        yield* applyWorkItemEventSteps(q, item.id, "dispatched");
        throw new Error("the caller's next write failed");
      }),
    ).rejects.toThrow("the caller's next write failed");

    expect(await getWorkItem(db, item.id)).toMatchObject({
      state: "queued",
      version: item.version,
    });
    expect(await listWorkItemEventRows(db, item.id)).toEqual([]);
  });

  test("a rejected event writes no row", async () => {
    const { db, item } = await harness();
    await expect(applyWorkItemEvent(db, item.id, "merge_accepted")).rejects.toThrow(
      TransitionRejectedError,
    );
    expect(await listWorkItemEventRows(db, item.id)).toEqual([]);
  });

  test("a restart row must name a known reason and an ask row must name one", async () => {
    const { db, item } = await harness();
    const insert = (kind: string, reason: string | null) =>
      seed(db, (q) =>
        q.orm.insert(q.t.workItemEvent).values({
          itemId: item.id,
          version: 99,
          at: 0,
          fromState: "running",
          toState: "queued",
          event: "restart",
          kind,
          reason,
        }),
      );
    await expect(insert("restart", "whim")).rejects.toThrow();
    await expect(insert("ask", null)).rejects.toThrow();
    await expect(insert("other", null)).rejects.toThrow();
    await insert("restart", "ci");
  });

  test("the history keeps the newest rows when limited", async () => {
    const { db, item } = await harness();
    await applyWorkItemEvent(db, item.id, "dispatched", { now: 1 });
    await applyWorkItemEvent(db, item.id, "pause", { now: 2 });
    await applyWorkItemEvent(db, item.id, "resume", { now: 3 });
    expect((await listWorkItemEventRows(db, item.id, 2)).map((row) => row.event)).toEqual([
      "pause",
      "resume",
    ]);
  });
});
