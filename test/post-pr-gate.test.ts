import { expect, test } from "bun:test";
import { FakeClock } from "../src/core";
import {
  advanceLinearSessionGeneration,
  enqueueOutbox,
  OutboxDispatcher,
  sqliteDb,
} from "../src/db";
import { createFakeTracker } from "../src/linear";
import { createLinearSessionProgress, deliverLinearOutbox } from "../src/loop";
import { tempDb } from "./helpers";

const ITEM = "01M6XY7BYGZ1G1V3302QT5GX5B";
const RUN = "698e1c5d-run";

function harness() {
  const db = tempDb();
  const clock = new FakeClock(1_000_000);
  const tracker = createFakeTracker();
  const dispatcher = new OutboxDispatcher(db, clock);
  dispatcher.setHandler((row, context) =>
    deliverLinearOutbox(row, tracker, async () => {}, context, sqliteDb(db)),
  );
  const flush = async () => {
    while ((await dispatcher.tick()).length > 0) await dispatcher.idle();
  };
  const post = async (key: string, kind: "thought" | "action" | "response", ordered = false) =>
    await enqueueOutbox(sqliteDb(db), {
      target: "linear",
      op: "activity",
      orderingKey: "session",
      idempotencyKey: key,
      ...(ordered ? { delivery: "ordered" as const } : {}),
      payload: { sessionId: "session", kind, body: key },
      now: clock.now(),
    });
  const titles = () =>
    tracker.sessionUpdates.flatMap((update) => (update.summary ? [update.summary] : []));
  return { db, clock, tracker, flush, post, titles };
}

const PROGRESS = [
  `update:${ITEM}:${RUN}:1:1`,
  `${RUN}:acp:1`,
  `${RUN}:working`,
  `${RUN}:keep:1`,
  `${ITEM}:wait:81:keep:1`,
  `${ITEM}:fix:92`,
  `${ITEM}:evidence:visual-proof:abc`,
];

test("a CI send-back in a later generation of an open pull request posts no progress", async () => {
  const { db, tracker, flush, post } = harness();
  await post(`pull-request-ready:${ITEM}:0`, "response", true);
  await flush();
  await advanceLinearSessionGeneration(sqliteDb(db), "session");
  for (const key of PROGRESS) await post(key, "thought");
  await post("pull-feedback:restart:ci:1", "thought");
  await post("merge-conflict:1:e51458c", "thought");
  await flush();
  expect(tracker.progress.map((update) => update.body)).toEqual([
    `pull-request-ready:${ITEM}:0`,
    "pull-feedback:restart:ci:1",
    "merge-conflict:1:e51458c",
  ]);
  db.close();
});

test("progress opens again in a later generation once the pull request merged", async () => {
  const { db, tracker, flush, post } = harness();
  await post(`pull-request-ready:${ITEM}:0`, "response", true);
  await post(`merged:${ITEM}:0`, "response", true);
  await flush();
  await advanceLinearSessionGeneration(sqliteDb(db), "session");
  await post(`update:${ITEM}:${RUN}:2:1`, "thought");
  await flush();
  expect(tracker.progress.at(-1)?.body).toBe(`update:${ITEM}:${RUN}:2:1`);
  db.close();
});

test("after the PR the title moves once to waiting to merge and once more to merged", async () => {
  const { db, clock, flush, post, titles } = harness();
  const progress = await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1", () =>
    clock.now(),
  );
  await progress.phase("publishing");
  await post(`pull-request-ready:${ITEM}:0`, "response", true);
  await progress.phase("merging");
  await flush();
  for (const step of [
    "Branch updated onto main e51458c, waiting for CI. Closeout does not run again.",
    "ENG-1: merging",
    "ENG-1 held: waiting for ENG-2 to merge first",
  ]) {
    clock.advance(130_000);
    await progress.mergeStatus(step);
    await flush();
  }
  await progress.phase("verifying");
  await progress.phase("publishing");
  clock.advance(130_000);
  await progress.phase("completed");
  await flush();
  expect(titles()).toEqual(["ENG-1: waiting to merge", "ENG-1: merged"]);
  db.close();
});

test("after the PR a restart names its phase once, without the round", async () => {
  const { db, clock, flush, post, titles } = harness();
  const progress = await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1", () =>
    clock.now(),
  );
  await post(`pull-request-ready:${ITEM}:0`, "response", true);
  await progress.phase("merging");
  await flush();
  clock.advance(130_000);
  await progress.restart("ci", 1, 7, 3);
  await progress.restartWait("ENG-1: waiting for a runner to fix CI (1 of 3)");
  await flush();
  clock.advance(130_000);
  await progress.restart("review", 2, 9, 3);
  await flush();
  expect(titles()).toEqual([
    "ENG-1: waiting to merge",
    "ENG-1: fixing CI",
    "ENG-1: fixing review comments",
  ]);
  db.close();
});
