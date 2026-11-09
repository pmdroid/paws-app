import { expect, test } from "bun:test";
import {
  advanceOutboxSessionSteps,
  attachSessionUpdatesSteps,
  claimOutboxHeadsSteps,
  coalesceOutboxSteps,
  completeOutboxSteps,
  enqueueOutboxOnceSteps,
  enqueueOutboxSteps,
  getOutboxSteps,
  isOutboxCurrentSteps,
  lastOutboxSequenceSteps,
  linearSessionClosedSteps,
  listOutboxSteps,
  outboxItemIdSteps,
  pullRequestReadyQueuedSteps,
  releaseOutboxLeaseSteps,
  stopOutboxSessionSteps,
  type Db,
  type NewOutbox,
} from "../src/db";
import { forEachDialect, insertWorkItem } from "./dialects";

function enqueue(db: Db, row: Omit<NewOutbox, "target"> & { target?: NewOutbox["target"] }) {
  return db.transaction((q) => enqueueOutboxSteps(q, { target: "linear", now: 1_000, ...row }));
}

function thought(idempotencyKey: string, body: string, extra: Record<string, unknown> = {}) {
  return {
    op: "activity",
    orderingKey: "ses",
    idempotencyKey,
    payload: { kind: "thought", body, ...extra },
  };
}

forEachDialect((open) => {
  test("a stored row reads back with its payload, in id order", async () => {
    const { db, close } = await open();
    try {
      const first = await enqueue(db, {
        target: "github",
        op: "comment",
        orderingKey: "ses",
        idempotencyKey: "a",
        payload: { nested: { n: 1, list: [true, null] } },
      });
      const second = await enqueue(db, { target: "github", op: "comment", idempotencyKey: "b" });
      const row = await db.run((q) => getOutboxSteps(q, first));
      expect(row).toMatchObject({
        id: first,
        target: "github",
        orderingKey: "ses",
        payload: { nested: { n: 1, list: [true, null] } },
        status: "pending",
        delivery: "ordered",
        generation: 0,
        priority: 5,
        attempts: 0,
        maxAttempts: 5,
        createdAt: 1_000,
        sentAt: null,
        lockedBy: null,
      });
      expect(await db.run((q) => getOutboxSteps(q, second + 1))).toBeNull();
      expect((await db.run((q) => listOutboxSteps(q))).map((r) => r.id)).toEqual([first, second]);
      expect((await db.run((q) => listOutboxSteps(q, "ses"))).map((r) => r.id)).toEqual([first]);
    } finally {
      await close();
    }
  });

  test("a repeated key returns the first id once, and throws otherwise", async () => {
    const { db, close } = await open();
    try {
      const row = { target: "slack", op: "post", idempotencyKey: "once" } as const;
      const id = await db.transaction((q) => enqueueOutboxOnceSteps(q, row));
      expect(await db.transaction((q) => enqueueOutboxOnceSteps(q, row))).toBe(id);
      expect(enqueue(db, row)).rejects.toThrow();
      expect(await db.run((q) => listOutboxSteps(q))).toHaveLength(1);
    } finally {
      await close();
    }
  });

  test("the last sequence number follows its prefix only", async () => {
    const { db, close } = await open();
    try {
      for (const key of ["seq:1", "seq:12", "seq:x", "seqz:99", "seq:3"])
        await enqueue(db, { target: "github", op: "comment", idempotencyKey: key });
      expect(await db.run((q) => lastOutboxSequenceSteps(q, "seq:"))).toBe(12);
      expect(await db.run((q) => lastOutboxSequenceSteps(q, "none:"))).toBe(0);
    } finally {
      await close();
    }
  });

  test("a claim takes each key's head, skips blocked keys and leases the row", async () => {
    const { db, close } = await open();
    try {
      const head = await enqueue(db, {
        target: "github",
        op: "c",
        orderingKey: "a",
        idempotencyKey: "1",
      });
      await enqueue(db, { target: "github", op: "c", orderingKey: "a", idempotencyKey: "2" });
      await enqueue(db, { target: "github", op: "c", orderingKey: "b", idempotencyKey: "3" });
      const loose = await enqueue(db, { target: "github", op: "c", idempotencyKey: "4" });
      const claimed = await db.run((q) =>
        claimOutboxHeadsSteps(q, {
          now: 2_000,
          leaseMs: 100,
          workerId: "w",
          blockedKeys: ["github:b"],
        }),
      );
      expect(claimed.map((row) => row.id).sort((x, y) => x - y)).toEqual([head, loose]);
      expect(claimed[0]).toMatchObject({ attempts: 1, lockedBy: "w", lockedUntil: 2_100 });
      const again = await db.run((q) => claimOutboxHeadsSteps(q, { now: 2_050 }));
      // The leased heads stay held; only key b, blocked before, is claimable now.
      expect(again.map((row) => row.orderingKey)).toEqual(["b"]);
      const row = claimed.find((entry) => entry.id === head)!;
      expect(await db.run((q) => isOutboxCurrentSteps(q, row))).toBe(true);
      expect(await db.transaction((q) => completeOutboxSteps(q, row, 2_060))).toBe(true);
      expect(await db.run((q) => getOutboxSteps(q, head))).toMatchObject({
        status: "sent",
        sentAt: 2_060,
        lockedBy: null,
        error: null,
      });
      expect(await db.transaction((q) => completeOutboxSteps(q, row, 2_070))).toBe(false);
    } finally {
      await close();
    }
  });

  test("progress sent within the interval holds the next thought back", async () => {
    const { db, close } = await open();
    try {
      const first = await enqueue(db, thought("t1", "one"));
      const [claimed] = await db.run((q) => claimOutboxHeadsSteps(q, { now: 2_000 }));
      expect(claimed?.id).toBe(first);
      await db.transaction((q) => completeOutboxSteps(q, claimed!, 2_000));
      const next = await enqueue(db, thought("t2", "two"));
      const options = { now: 3_000, progressIntervalMs: 30_000 };
      expect(await db.run((q) => claimOutboxHeadsSteps(q, options))).toHaveLength(0);
      const later = await db.run((q) => claimOutboxHeadsSteps(q, { ...options, now: 40_000 }));
      expect(later.map((row) => row.id)).toEqual([next]);
    } finally {
      await close();
    }
  });

  test("a new generation drops pending rows, and Stop fences once", async () => {
    const { db, close } = await open();
    try {
      const id = await enqueue(db, {
        target: "github",
        op: "c",
        orderingKey: "s",
        idempotencyKey: "1",
      });
      const [claimed] = await db.run((q) => claimOutboxHeadsSteps(q, { now: 2_000 }));
      expect(
        await db.transaction((q) => advanceOutboxSessionSteps(q, "github", "s", { now: 1 })),
      ).toBe(1);
      expect(await db.run((q) => isOutboxCurrentSteps(q, claimed!))).toBe(false);
      expect(await db.run((q) => getOutboxSteps(q, id))).toMatchObject({
        status: "dropped",
        error: "Superseded by an accepted newer session generation.",
      });
      await db.run((q) => releaseOutboxLeaseSteps(q, claimed!));
      expect((await db.run((q) => getOutboxSteps(q, id)))?.lockedBy).toBeNull();
      expect(await db.transaction((q) => stopOutboxSessionSteps(q, "github", "s", 2))).toBe(2);
      expect(await db.transaction((q) => stopOutboxSessionSteps(q, "github", "s", 3))).toBe(2);
      const fenced = await enqueue(db, {
        target: "github",
        op: "c",
        orderingKey: "s",
        idempotencyKey: "2",
      });
      expect(await db.run((q) => getOutboxSteps(q, fenced))).toMatchObject({
        status: "dropped",
        generation: 2,
        error: "Rejected by the persisted session fence.",
      });
    } finally {
      await close();
    }
  });

  test("a repeated thought is not stored again; newer progress supersedes ephemeral lines", async () => {
    const { db, close } = await open();
    try {
      const first = await enqueue(db, thought("t1", "same"));
      expect(await enqueue(db, thought("t2", " same "))).toBe(first);
      const ephemeral = await enqueue(db, thought("t3", "working", { ephemeral: true }));
      await enqueue(db, thought("t4", "next"));
      expect(await db.run((q) => getOutboxSteps(q, ephemeral))).toMatchObject({
        status: "dropped",
        error: "Superseded by newer progress.",
      });
      const response = await enqueue(db, {
        op: "activity",
        orderingKey: "ses",
        idempotencyKey: "r",
        payload: { kind: "response", body: "done" },
      });
      const rows = await db.run((q) => listOutboxSteps(q, "ses"));
      expect(rows.map((row) => [row.idempotencyKey, row.status])).toEqual([
        ["t1", "pending"],
        ["t3", "dropped"],
        ["t4", "pending"],
        ["r", "pending"],
      ]);
      expect(rows.find((row) => row.id === response)?.delivery).toBe("terminal");
      expect(await db.run((q) => linearSessionClosedSteps(q, "ses", 0))).toBe(true);
      expect(await db.run((q) => linearSessionClosedSteps(q, "ses", 1))).toBe(false);
    } finally {
      await close();
    }
  });

  test("a claimed thought absorbs the thoughts that follow it", async () => {
    const { db, close } = await open();
    try {
      const first = await enqueue(db, thought("t1", "a"));
      const second = await enqueue(db, thought("t2", "b"));
      const [claimed] = await db.run((q) => claimOutboxHeadsSteps(q, { now: 2_000 }));
      const merged = await db.transaction((q) =>
        coalesceOutboxSteps(q, claimed!, { now: 2_000, thoughts: true }),
      );
      expect(merged.payload).toEqual({ kind: "thought", body: "a\n\nb" });
      expect((await db.run((q) => getOutboxSteps(q, first)))?.payload).toEqual(merged.payload);
      expect(await db.run((q) => getOutboxSteps(q, second))).toMatchObject({
        status: "dropped",
        error: `Merged into outbox ${first}.`,
      });
    } finally {
      await close();
    }
  });

  test("pending session updates ride along with a delivery", async () => {
    const { db, close } = await open();
    try {
      const id = await enqueue(db, {
        op: "activity",
        orderingKey: "ses",
        idempotencyKey: "r",
        payload: { kind: "response", body: "done" },
      });
      const update = await enqueue(db, {
        op: "linear.session.update",
        orderingKey: "ses",
        idempotencyKey: "u",
        payload: { plan: ["x"] },
      });
      await db.transaction((q) => attachSessionUpdatesSteps(q, id, 2_000));
      expect((await db.run((q) => getOutboxSteps(q, id)))?.payload).toEqual({
        kind: "response",
        body: "done",
        session: { plan: ["x"] },
      });
      expect(await db.run((q) => getOutboxSteps(q, update))).toMatchObject({
        status: "dropped",
        error: `Sending with outbox ${id}.`,
      });
    } finally {
      await close();
    }
  });

  test("a row belongs to the item its payload names", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item-1");
      const named = await enqueue(db, {
        op: "status",
        idempotencyKey: "s",
        payload: { itemId: "item-1" },
      });
      const other = await enqueue(db, {
        op: "status",
        idempotencyKey: "o",
        payload: { itemId: "gone" },
      });
      expect(await db.run((q) => outboxItemIdSteps(q, named))).toBe("item-1");
      expect(await db.run((q) => outboxItemIdSteps(q, other))).toBeNull();
    } finally {
      await close();
    }
  });

  test("a queued pull request ready note is found in its generation", async () => {
    const { db, close } = await open();
    try {
      await enqueue(db, {
        op: "activity",
        orderingKey: "ses",
        idempotencyKey: "pull-request-ready:1",
        payload: { kind: "thought", body: "PR" },
      });
      expect(await db.run((q) => pullRequestReadyQueuedSteps(q, "ses", 0))).toBe(true);
      expect(await db.run((q) => pullRequestReadyQueuedSteps(q, "ses", 1))).toBe(false);
      expect(await db.run((q) => pullRequestReadyQueuedSteps(q, "other", 0))).toBe(false);
    } finally {
      await close();
    }
  });
});
