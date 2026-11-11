import { askSteps as rawAsk } from "../questions";
import { describe, expect, test } from "bun:test";
import {
  applyWorkItemEventSteps,
  beginMergeCall,
  DEFAULT_PULL_FEEDBACK_WAIT,
  mergeCallInFlight,
  beginImplementRun,
  enterMergeQueue,
  getWorkItem,
  getWorkItemSteps,
  insertQueuedItem,
  migrate,
  openDatabase,
  recordConfirmedRemoteMerge,
  sqliteDb,
  syncSteps,
} from "../db";
import { advanceMerge, type MergeCapabilities } from "./advance";

function queued() {
  const db = openDatabase(":memory:");
  migrate(db);
  insertQueuedItem(db, { id: "eng-1", now: 1, sessionKey: "s-1" });
  beginImplementRun(db, "eng-1", 1);
  enterMergeQueue(db, "eng-1", { phase: "merge_queue", baseSha: "b", wipCommit: "h" });
  return db;
}

function capabilities(overrides: Partial<MergeCapabilities> = {}) {
  const calls: string[] = [];
  const unused = (name: string) => () => {
    throw new Error(`${name} was not expected`);
  };
  const caps: MergeCapabilities = {
    ask,
    now: () => 10,
    stopped: async () => false,
    publish: unused("publish"),
    settings: unused("settings"),
    policyDigests: unused("policyDigests"),
    packages: unused("packages"),
    assertReady: unused("assertReady"),
    riskApproval: async () => "not_required",
    askRiskApproval: unused("askRiskApproval"),
    session: () => "s-1",
    fetchMain: unused("fetchMain"),
    ciFixAttempts: async () => 3,
    feedbackWait: () => DEFAULT_PULL_FEEDBACK_WAIT,
    readPullCi: unused("readPullCi"),
    readPull: unused("readPull"),
    dependencyHold: () => syncSteps(() => null),
    mergeLane: async () => "",
    mergedOutsideLane: async () => null,
    completed: () => calls.push("completed"),
    voice: {
      thought: unused("thought"),
      status: unused("status"),
      afterPullRequest: unused("afterPullRequest"),
      flush: async () => {},
    },
    ...overrides,
  };
  return { caps, calls };
}

describe("advanceMerge", () => {
  test("a missing or finished item is obsolete and publishes nothing", async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const { caps } = capabilities();
    expect(
      await advanceMerge(db, sqliteDb(db), { itemId: "gone", payload: {}, jobId: 1 }, caps),
    ).toEqual({
      kind: "obsolete",
    });
  });

  test("a recorded remote merge completes the item before anything is published", async () => {
    const db = queued();
    await recordConfirmedRemoteMerge(sqliteDb(db), {
      itemId: "eng-1",
      repositoryOwner: "acme",
      repositoryName: "app",
      pullNumber: 7,
      pullUrl: null,
      mergeSha: "m",
      confirmedAt: 5,
    });
    await beginMergeCall(sqliteDb(db), "eng-1", "h", 1);
    const { caps, calls } = capabilities();
    expect(
      await advanceMerge(db, sqliteDb(db), { itemId: "eng-1", payload: {}, jobId: 1 }, caps),
    ).toEqual({
      kind: "obsolete",
    });
    expect(getWorkItem(db, "eng-1")?.state).toBe("merged");
    expect(calls).toEqual(["completed"]);
    expect(await mergeCallInFlight(sqliteDb(db), "eng-1")).toBe(false);
  });

  test("a durable marker without a payload flag fences publication after a confirmed negative read", async () => {
    const db = queued();
    try {
      await beginMergeCall(sqliteDb(db), "eng-1", "h", 1);
      const { caps } = capabilities();
      expect(
        await advanceMerge(db, sqliteDb(db), { itemId: "eng-1", payload: {}, jobId: 1 }, caps),
      ).toEqual({
        kind: "returned",
      });
      expect(getWorkItem(db, "eng-1")?.state).toBe("verifying");
      expect(await mergeCallInFlight(sqliteDb(db), "eng-1")).toBe(false);
    } finally {
      db.close();
    }
  });

  test("an unknown read without a durable merge marker follows normal publication handling", async () => {
    const db = queued();
    try {
      const { caps } = capabilities({
        mergedOutsideLane: async () => "unknown",
        publish: async () => ({
          kind: "failed",
          reason: "no_github",
          message: "GitHub App is not configured.",
        }),
      });
      expect(
        await advanceMerge(db, sqliteDb(db), { itemId: "eng-1", payload: {}, jobId: 1 }, caps),
      ).toMatchObject({
        kind: "failed",
        reason: "no_github",
      });
      expect(await mergeCallInFlight(sqliteDb(db), "eng-1")).toBe(false);
    } finally {
      db.close();
    }
  });

  test("a publication that cannot go ahead is the step", async () => {
    const db = queued();
    const { caps } = capabilities({
      publish: async () => ({ kind: "failed", reason: "publish", message: "no pull request" }),
    });
    expect(
      await advanceMerge(db, sqliteDb(db), { itemId: "eng-1", payload: {}, jobId: 1 }, caps),
    ).toEqual({
      kind: "failed",
      reason: "publish",
      message: "no pull request",
    });
  });
});

const ask: typeof rawAsk = function* (q, asker, ...args) {
  const result = yield* rawAsk(q, asker, ...args);
  if ((yield* getWorkItemSteps(q, asker.itemId))?.state !== "awaiting_input")
    yield* applyWorkItemEventSteps(q, asker.itemId, "blocking_question");
  return result;
};
