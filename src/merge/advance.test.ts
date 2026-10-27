import { ask as rawAsk } from "../questions";
import { describe, expect, test } from "bun:test";
import {
  applyWorkItemEvent,
  beginImplementRun,
  enterMergeQueue,
  getWorkItem,
  insertQueuedItem,
  migrate,
  openDatabase,
  recordConfirmedRemoteMerge,
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
    stopped: () => false,
    publish: unused("publish"),
    settings: unused("settings"),
    policyDigest: unused("policyDigest"),
    packages: unused("packages"),
    assertReady: unused("assertReady"),
    riskApproval: async () => "not_required",
    askRiskApproval: unused("askRiskApproval"),
    session: () => "s-1",
    fetchMain: unused("fetchMain"),
    ciFixAttempts: () => 3,
    dependencyHold: () => null,
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
    expect(await advanceMerge(db, { itemId: "gone", payload: {}, jobId: 1 }, caps)).toEqual({
      kind: "obsolete",
    });
  });

  test("a recorded remote merge completes the item before anything is published", async () => {
    const db = queued();
    recordConfirmedRemoteMerge(db, {
      itemId: "eng-1",
      repositoryOwner: "acme",
      repositoryName: "app",
      pullNumber: 7,
      pullUrl: null,
      mergeSha: "m",
      confirmedAt: 5,
    });
    const { caps, calls } = capabilities();
    expect(await advanceMerge(db, { itemId: "eng-1", payload: {}, jobId: 1 }, caps)).toEqual({
      kind: "obsolete",
    });
    expect(getWorkItem(db, "eng-1")?.state).toBe("merged");
    expect(calls).toEqual(["completed"]);
  });

  test("a publication that cannot go ahead is the step", async () => {
    const db = queued();
    const { caps } = capabilities({
      publish: async () => ({ kind: "failed", reason: "publish", message: "no pull request" }),
    });
    expect(await advanceMerge(db, { itemId: "eng-1", payload: {}, jobId: 1 }, caps)).toEqual({
      kind: "failed",
      reason: "publish",
      message: "no pull request",
    });
  });
});

const ask: typeof rawAsk = (db, asker, ...args) => {
  const result = rawAsk(db, asker, ...args);
  if (getWorkItem(db, asker.itemId)?.state !== "awaiting_input")
    applyWorkItemEvent(db, asker.itemId, "blocking_question");
  return result;
};
