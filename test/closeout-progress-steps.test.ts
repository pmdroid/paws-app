import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  acceptedCloseoutReviewsSteps,
  acceptedCloseoutRunsSteps,
  appendCloseoutOutputSteps,
  closeoutHeadsStartedSteps,
  closeoutPolicyDigestsSteps,
  ensureCloseoutProgressSteps,
  failedCloseoutReviewsSteps,
  finishCloseoutProgressSteps,
  getCloseoutProgressSteps,
  latestCloseoutIdentitySteps,
  listCloseoutProgressStatesSteps,
  listCloseoutProgressSteps,
  setRunningCloseoutStepDetailSteps,
  upsertCloseoutStepSteps,
  type CloseoutProgressIdentity,
  type CloseoutStepWrite,
  type Db,
} from "../src/db";
import { forEachDialect, insertWorkItem, seed } from "./dialects";

const identity = (head: string, extra: Partial<CloseoutProgressIdentity> = {}) => ({
  taskId: "task",
  base: "base",
  head,
  policyDigest: "policy",
  policyPath: null,
  ...extra,
});

function step(id: string, extra: Partial<CloseoutStepWrite> = {}): CloseoutStepWrite {
  return {
    id,
    kind: "command",
    state: "running",
    command: `run ${id}`,
    detail: null,
    attempt: 1,
    timeoutSeconds: 60,
    startedAt: 10,
    finishedAt: null,
    exitCode: null,
    timedOut: false,
    timeoutReason: null,
    truncated: false,
    logPath: null,
    evidencePath: null,
    findings: null,
    ordinal: 0,
    ...extra,
  };
}

function upsert(db: Db, head: string, write: CloseoutStepWrite, now: number) {
  return db.transaction((q) => upsertCloseoutStepSteps(q, "item", identity(head), write, now));
}

function finish(db: Db, head: string, decision: string, now: number) {
  return db.transaction((q) =>
    finishCloseoutProgressSteps(q, "item", identity(head), decision, now),
  );
}

function progress(db: Db, head: string) {
  return db.run((q) => getCloseoutProgressSteps(q, "item", head));
}

forEachDialect((open) => {
  test("a run is stored once per candidate and a reset clears its decision", async () => {
    const { db, close } = await open();
    try {
      const ensure = (now: number, reset: boolean, extra: Partial<CloseoutProgressIdentity> = {}) =>
        db.transaction((q) =>
          ensureCloseoutProgressSteps(q, "item", identity("h1", extra), now, reset),
        );
      const id = await ensure(1, false, { policyPath: ".closeout.yml", recheckDigest: "r" });
      expect(id).toBe("item\ntask\nbase\nh1\npolicy");
      await finish(db, "h1", "accepted", 2);
      expect(await ensure(3, false)).toBe(id);
      expect(await progress(db, "h1")).toMatchObject({
        policyPath: ".closeout.yml",
        decision: "accepted",
        startedAt: 1,
        updatedAt: 3,
        finishedAt: 2,
        steps: [],
      });
      expect(await db.run((q) => closeoutPolicyDigestsSteps(q, "item", "h1"))).toEqual({
        digest: "policy",
        recheck: "r",
        decision: "accepted",
      });
      await ensure(4, true);
      expect(await progress(db, "h1")).toMatchObject({ decision: null, finishedAt: null });
      expect(await progress(db, "h2")).toBeNull();
    } finally {
      await close();
    }
  });

  test("a step keeps its output, start and findings until it runs again", async () => {
    const { db, close } = await open();
    try {
      await upsert(db, "h1", step("lint", { ordinal: 1 }), 1);
      const append = (text: string, truncated = false) =>
        db.transaction((q) =>
          appendCloseoutOutputSteps(
            q,
            "item",
            identity("h1"),
            "lint",
            "stdout",
            text,
            truncated,
            2,
          ),
        );
      await append("one ");
      await append("two");
      await db.transaction((q) =>
        appendCloseoutOutputSteps(q, "item", identity("h1"), "lint", "stderr", "err", false, 2),
      );
      await db.transaction((q) =>
        appendCloseoutOutputSteps(q, "item", identity("h1"), "absent", "stdout", "x", true, 9),
      );
      await upsert(
        db,
        "h1",
        step("lint", {
          state: "failed",
          command: "",
          ordinal: -1,
          startedAt: null,
          finishedAt: 5,
          exitCode: 1,
          findings: "bad",
          durationMs: 40,
          tokens: 7,
        }),
        5,
      );
      const run = await progress(db, "h1");
      expect(run?.updatedAt).toBe(5);
      expect(run?.steps).toEqual([
        {
          id: "lint",
          kind: "command",
          state: "failed",
          command: "run lint",
          detail: null,
          attempt: 1,
          timeoutSeconds: 60,
          startedAt: 10,
          finishedAt: 5,
          exitCode: 1,
          timedOut: false,
          timeoutReason: null,
          truncated: false,
          logPath: null,
          evidencePath: null,
          findings: "bad",
          ordinal: 1,
          durationMs: 40,
          tokens: 7,
          failOn: null,
          preExisting: null,
          stdout: "one two",
          stderr: "err",
        },
      ]);
      await upsert(db, "h1", step("lint", { attempt: 2, startedAt: 20 }), 6);
      expect((await progress(db, "h1"))?.steps[0]).toMatchObject({
        state: "running",
        attempt: 2,
        startedAt: 20,
        findings: null,
        durationMs: null,
        stdout: "",
        stderr: "",
      });
    } finally {
      await close();
    }
  });

  test("output stops at the cap and marks the step truncated", async () => {
    const { db, close } = await open();
    try {
      await upsert(db, "h1", step("test"), 1);
      const append = (text: string, truncated: boolean) =>
        db.transaction((q) =>
          appendCloseoutOutputSteps(
            q,
            "item",
            identity("h1"),
            "test",
            "stdout",
            text,
            truncated,
            2,
          ),
        );
      await append("a", true);
      await append("b", false);
      expect((await progress(db, "h1"))?.steps[0]).toMatchObject({ stdout: "ab", truncated: true });
      await append("x".repeat(64 * 1024), false);
      const [stored] = (await progress(db, "h1"))!.steps;
      expect(Buffer.byteLength(stored!.stdout)).toBe(64 * 1024);
      expect(stored?.truncated).toBe(true);
    } finally {
      await close();
    }
  });

  test("a review's snapshot, marks and accepted runs read back", async () => {
    const { db, close } = await open();
    try {
      const review = step("review", {
        kind: "review",
        state: "passed",
        findings: "one P2",
        findingSeverities: ["P2"],
        failOn: "P1",
        preExisting: [0, 2],
        ordinal: 2,
      });
      await upsert(db, "h1", review, 1);
      await upsert(db, "h1", step("lint", { state: "passed" }), 1);
      await finish(db, "h1", "accepted", 3);
      expect((await progress(db, "h1"))?.steps.map((s) => s.id)).toEqual(["lint", "review"]);
      expect((await progress(db, "h1"))?.steps[1]).toMatchObject({
        findings: "one P2",
        findingSeverities: ["P2"],
        failOn: "P1",
        preExisting: [0, 2],
      });
      const reviews = [{ id: "review", attempt: 1, failOn: "P1" as const, preExisting: [0, 2] }];
      expect(await db.run((q) => acceptedCloseoutReviewsSteps(q, "item", "h1"))).toEqual({
        taskId: "task",
        head: "h1",
        reviews,
      });
      expect(await db.run((q) => acceptedCloseoutReviewsSteps(q, "item", null))).toEqual({
        taskId: "task",
        head: "h1",
        reviews,
      });
      await upsert(db, "h2", step("lint"), 4);
      expect(await db.run((q) => acceptedCloseoutReviewsSteps(q, "item", null))).toBeNull();
      expect(await db.run((q) => acceptedCloseoutReviewsSteps(q, "item", "h1"))).not.toBeNull();
      expect(await db.run((q) => acceptedCloseoutRunsSteps(q))).toEqual([
        { itemId: "item", taskId: "task", head: "h1", at: 3, reviews },
      ]);
    } finally {
      await close();
    }
  });

  test("the failed reviews of the latest decided run", async () => {
    const { db, close } = await open();
    try {
      expect(await db.run((q) => failedCloseoutReviewsSteps(q, "item"))).toBeNull();
      const review = (id: string, state: CloseoutStepWrite["state"]) =>
        step(id, { kind: "review", state, failOn: "P2", preExisting: [1] });
      await upsert(db, "h1", review("a", "failed"), 1);
      await upsert(db, "h1", review("b", "passed"), 1);
      await upsert(db, "h1", review("c", "exhausted"), 1);
      await finish(db, "h1", "rejected", 2);
      await upsert(db, "h2", review("a", "running"), 3);
      expect(await db.run((q) => failedCloseoutReviewsSteps(q, "item"))).toEqual({
        taskId: "task",
        head: "h1",
        reviews: [
          { id: "a", attempt: 1, failOn: "P2", preExisting: [1] },
          { id: "c", attempt: 1, failOn: "P2", preExisting: [1] },
        ],
      });
    } finally {
      await close();
    }
  });

  test("a rejection retires the head's acceptance, carried or not", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      const accepted = (head: string | null) =>
        db.run((q) =>
          q.exec(
            q.orm
              .update(q.t.workItem)
              .set({ acceptedHead: head })
              .where(eq(q.t.workItem.id, "item")),
          ),
        );
      const acceptedHead = async () =>
        (
          await db.run((q) =>
            q.one(
              q.orm
                .select({ head: q.t.workItem.acceptedHead })
                .from(q.t.workItem)
                .where(eq(q.t.workItem.id, "item")),
            ),
          )
        )?.head;
      await accepted("h1");
      await finish(db, "h1", "blocked", 1);
      expect(await acceptedHead()).toBe("h1");
      await finish(db, "h1", "rejected", 2);
      expect(await acceptedHead()).toBeNull();
      await accepted("h1");
      await seed(db, (q) =>
        q.orm
          .insert(q.t.mergeCarriedAccept)
          .values({ itemId: "item", head: "h2", acceptedHead: "h1", base: "b", recordedAt: 1 }),
      );
      await finish(db, "h3", "exhausted", 3);
      expect(await acceptedHead()).toBe("h1");
      await finish(db, "h2", "exhausted", 4);
      expect(await acceptedHead()).toBeNull();
    } finally {
      await close();
    }
  });

  test("a running step's note and the item's latest runs", async () => {
    const { db, close } = await open();
    try {
      await upsert(db, "h1", step("lint"), 1);
      await upsert(db, "h1", step("test", { state: "passed" }), 1);
      await upsert(db, "h2", step("lint", { ordinal: 1 }), 5);
      const note = (stepId: string, detail: string | null, now: number) =>
        db.transaction((q) =>
          setRunningCloseoutStepDetailSteps(q, "item", "h1", stepId, detail, now),
        );
      await note("lint", "waiting for a runner", 7);
      await note("test", "ignored", 8);
      const h1 = await progress(db, "h1");
      expect(h1?.updatedAt).toBe(7);
      expect(h1?.steps.map((s) => s.detail)).toEqual(["waiting for a runner", null]);
      expect((await progress(db, "h2"))?.steps[0]?.detail).toBeNull();
      expect(await db.run((q) => latestCloseoutIdentitySteps(q, "item"))).toEqual({
        head: "h1",
        policyDigest: "policy",
      });
      expect(await db.run((q) => latestCloseoutIdentitySteps(q, "other"))).toBeNull();
      expect(await db.run((q) => closeoutPolicyDigestsSteps(q, "item", "h2"))).toMatchObject({
        digest: "policy",
      });
      expect(await db.run((q) => closeoutPolicyDigestsSteps(q, "item", "h9"))).toBeNull();
      expect(await db.run((q) => closeoutHeadsStartedSteps(q, "item"))).toEqual(
        new Map([
          ["h1", 1],
          ["h2", 5],
        ]),
      );
      expect((await db.run((q) => listCloseoutProgressSteps(q))).map((r) => r.head)).toEqual([
        "h2",
        "h1",
      ]);
      expect(await db.run((q) => listCloseoutProgressStatesSteps(q))).toEqual([
        {
          id: "item\ntask\nbase\nh2\npolicy",
          itemId: "item",
          head: "h2",
          policyDigest: "policy",
          decision: null,
          updatedAt: 5,
          finishedAt: null,
          steps: [{ state: "running" }],
        },
        {
          id: "item\ntask\nbase\nh1\npolicy",
          itemId: "item",
          head: "h1",
          policyDigest: "policy",
          decision: null,
          updatedAt: 7,
          finishedAt: null,
          steps: [{ state: "running" }, { state: "passed" }],
        },
      ]);
    } finally {
      await close();
    }
  });
});
