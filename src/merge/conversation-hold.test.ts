import { afterEach, describe, expect, test } from "bun:test";
import {
  applyLinearTurns,
  beginImplementRun,
  enterMergeQueue,
  getConfirmedRemoteMerge,
  getWorkItem,
  insertQueuedItem,
  listPendingLinearTurns,
  migrate,
  openDatabase,
  recordLinearTurn,
} from "../db";
import { createFakeMergeQueue } from "../github";
import { mergeHarness, type MergeHarness } from "./advance-harness";
import { reviewHold } from "./orders";

const WAIT = { quietMs: 60_000, maxMs: 300_000 };
const HELD = {
  kind: "wait",
  reason: "review",
  queued: true,
  message:
    "Waiting for the conversation in the Linear session to finish before this pull request merges.",
};

let harness: MergeHarness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

function reply(db: Parameters<typeof recordLinearTurn>[0], session: string, key: string) {
  recordLinearTurn(db, {
    eventKey: key,
    activityId: null,
    sessionId: session,
    actorId: "user-pascal",
    body: "Is the retry covered by a test?",
    payload: "{}",
    createdAtMs: 2,
    now: 2,
  });
}

test("a session reply not handed on, or an open conversation, holds the merge until it ends", () => {
  const db = openDatabase(":memory:");
  migrate(db);
  insertQueuedItem(db, { id: "eng-1", now: 1, sessionKey: "s-1" });
  beginImplementRun(db, "eng-1", 1);
  enterMergeQueue(db, "eng-1", { phase: "merge_queue", baseSha: "b", wipCommit: "h" });
  let open = false;
  const conversing = (itemId: string) => open && itemId === "eng-1";
  expect(reviewHold(db, "eng-1", 10, WAIT, conversing)).toBeNull();

  reply(db, "s-1", "turn-1");
  expect(reviewHold(db, "eng-1", 10, WAIT, conversing)).toMatchObject(HELD);
  open = true;
  applyLinearTurns(db, "s-1", ["turn-1"], "eng-1");
  expect(listPendingLinearTurns(db, "s-1")).toEqual([]);
  expect(reviewHold(db, "eng-1", 10, WAIT, conversing)).toMatchObject(HELD);
  open = false;
  expect(reviewHold(db, "eng-1", 10, WAIT, conversing)).toBeNull();
  db.close();
});

describe("advanceMerge while a conversation is open", () => {
  test("a merge pass with a pending session reply waits, then merges after the helper finishes", async () => {
    harness = await mergeHarness();
    const h = harness;
    const item = await h.addItem("ENG-1");
    reply(h.db, "ses-ENG-1", "turn-1");
    expect(await h.pass("ENG-1")).toMatchObject(HELD);
    expect(h.github.merged).toEqual([]);

    let open = true;
    h.state.conversing = (itemId) => open && itemId === "ENG-1";
    applyLinearTurns(h.db, "ses-ENG-1", ["turn-1"], "ENG-1");
    expect(await h.pass("ENG-1")).toMatchObject(HELD);
    expect(h.github.merged).toEqual([]);

    open = false;
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(h.github.merged).toEqual([
      { repository: "acme/app", number: 1, expectedHeadSha: item.accepted },
    ]);
  });

  test("a session reply recorded while the merge attempt runs holds the squash", async () => {
    harness = await mergeHarness();
    const h = harness;
    await h.addItem("ENG-1");
    let recorded = false;
    h.state.ci = () => {
      if (!recorded) {
        reply(h.db, "ses-ENG-1", "turn-1");
        recorded = true;
      }
      return undefined;
    };
    expect(await h.pass("ENG-1")).toMatchObject(HELD);
    expect(recorded).toBe(true);
    expect(h.github.merged).toEqual([]);
    expect(getConfirmedRemoteMerge(h.db, "ENG-1")).toBeNull();
    expect(getWorkItem(h.db, "ENG-1")?.state).toBe("merge_queue");
  });

  test("under the GitHub merge queue order, an open conversation keeps the pull request out of GitHub's queue", async () => {
    let head = async (): Promise<string> => "";
    const queue = createFakeMergeQueue({ headOf: () => head() });
    harness = await mergeHarness({ settings: { order: "github-queue" }, queue });
    const h = harness;
    await h.addItem("ENG-1");
    head = () => h.remoteHead("ENG-1");
    let open = true;
    h.state.conversing = () => open;
    expect(await h.pass("ENG-1")).toMatchObject(HELD);
    expect(queue.enqueued).toEqual([]);
    open = false;
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", githubQueue: { queued: true } });
    expect(queue.enqueued).toHaveLength(1);
  });
});
