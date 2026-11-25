import { afterEach, describe, expect, test } from "bun:test";
import { recordMergeWaitMarkSteps, type Db, type MergeWaitMarkKind, type Q } from "../src/db";
import { readStageTimes } from "../src/metrics";
import { handleMetricsRequest } from "../src/settings";
import { insertWorkItemSteps } from "./pglite-fixtures";
import { tempStore } from "./pglite";

const MINUTE = 60_000;
const START = Date.UTC(2026, 10, 25, 8, 0, 0);
const WINDOW = { from: START - 60 * MINUTE, to: START + 12 * 60 * MINUTE, now: START + 1e8 };
let closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.map((close) => close()));
  closers = [];
});

async function store(): Promise<Db> {
  const opened = await tempStore();
  closers.push(opened.close);
  return opened.db;
}

async function seedItem(db: Db, id: string, states: [string, number][], repo = "app") {
  await db.run(function* (q: Q) {
    yield* insertWorkItemSteps(q, id, START);
    yield* q.exec(
      q.orm
        .insert(q.t.workItemRepository)
        .values({ itemId: id, owner: "acme", repo, remoteUrl: `https://github.com/acme/${repo}` }),
    );
    let at = START;
    let from = "queued";
    for (const [index, [to, minutes]] of states.entries()) {
      at += minutes * MINUTE;
      yield* q.exec(
        q.orm
          .insert(q.t.workItemEvent)
          .values({ itemId: id, version: index + 1, at, fromState: from, toState: to, event: to }),
      );
      from = to;
    }
  });
}

function mark(db: Db, itemId: string, kind: MergeWaitMarkKind, minutes: number) {
  return db.run((q) =>
    recordMergeWaitMarkSteps(q, { itemId, head: "abc", kind, at: START + minutes * MINUTE }),
  );
}

async function seedCheck(db: Db, progressId: string, minutes: number, timedOut = 0) {
  await db.run(function* (q: Q) {
    yield* q.exec(
      q.orm.insert(q.t.closeoutProgress).values({
        id: progressId,
        itemId: "item-a",
        taskId: "task",
        base: "main",
        head: "abc",
        policyDigest: "digest",
        startedAt: START,
        updatedAt: START,
      }),
    );
    yield* q.exec(
      q.orm.insert(q.t.closeoutStep).values({
        progressId,
        stepId: "test",
        kind: "command",
        state: "passed",
        command: "bun test",
        attempt: 1,
        ordinal: 0,
        startedAt: START,
        finishedAt: START + minutes * MINUTE,
        timedOut,
      }),
    );
  });
}

describe("stage times", () => {
  test("adds up each state, turns and Closeout rounds for one item", async () => {
    const db = await store();
    await seedItem(db, "item-a", [
      ["running", 10],
      ["verifying", 60],
      ["merge_queue", 30],
      ["merged", 5],
    ]);
    const report = await readStageTimes(db, WINDOW);
    expect(report.items).toHaveLength(1);
    expect(report.total.stagesMs).toEqual({
      queued: 10 * MINUTE,
      running: 60 * MINUTE,
      verifying: 30 * MINUTE,
      awaitingInput: 0,
      mergeQueue: 5 * MINUTE,
    });
    expect(report.total.mergeWaitMs).toEqual({
      review: 0,
      githubQueue: 0,
      unclassified: 5 * MINUTE,
    });
    expect([report.total.turns, report.total.closeoutRounds]).toEqual([1, 1]);
  });

  test("splits a code-owner review wait from GitHub's queue without duplicating retries", async () => {
    const db = await store();
    await seedItem(db, "item-a", [
      ["running", 0],
      ["verifying", 10],
      ["merge_queue", 10],
      ["merged", 65],
    ]);
    await mark(db, "item-a", "review_started", 20);
    await mark(db, "item-a", "review_started", 35);
    await mark(db, "item-a", "enqueued", 80);
    await mark(db, "item-a", "review_ended", 80);
    await mark(db, "item-a", "review_ended", 82);
    await mark(db, "item-a", "enqueued", 83);
    const report = await readStageTimes(db, WINDOW);
    expect(report.items[0]!.stagesMs.mergeQueue).toBe(65 * MINUTE);
    expect(report.items[0]!.mergeWaitMs).toEqual({
      review: 60 * MINUTE,
      githubQueue: 5 * MINUTE,
      unclassified: 0,
    });
  });

  test("leaves an older merge queue wait without evidence unclassified", async () => {
    const db = await store();
    await seedItem(db, "item-a", [
      ["merge_queue", 0],
      ["merged", 40],
    ]);
    const report = await readStageTimes(db, WINDOW);
    expect(report.total.mergeWaitMs).toEqual({
      review: 0,
      githubQueue: 0,
      unclassified: 40 * MINUTE,
    });
  });

  test("splits awaiting input by question and filters by repository", async () => {
    const db = await store();
    await seedItem(db, "item-a", [
      ["running", 0],
      ["awaiting_input", 5],
      ["running", 120],
    ]);
    await seedItem(db, "item-b", [["running", 30]], "other");
    await db.run((q) =>
      q.exec(
        q.orm.insert(q.t.question).values({
          id: "q1",
          itemId: "item-a",
          sessionId: "s",
          body: "Which?",
          status: "answered",
          reason: "plan",
          createdAt: START + 5 * MINUTE,
          answeredAt: START + 125 * MINUTE,
        }),
      ),
    );
    const report = await readStageTimes(db, {
      ...WINDOW,
      repository: { owner: "acme", repo: "app" },
    });
    expect(report.items.map((item) => item.itemId)).toEqual(["item-a"]);
    expect(report.items[0]!.waitingForPerson).toEqual([
      { questionId: "q1", reason: "plan", ms: 120 * MINUTE },
    ]);
    expect(report.total.turns).toBe(2);
  });

  test("reports the median and p95 of each Closeout check with timeouts", async () => {
    const db = await store();
    await seedItem(db, "item-a", []);
    await seedCheck(db, "p1", 20);
    await seedCheck(db, "p2", 30, 1);
    const report = await readStageTimes(db, WINDOW);
    expect(report.checks).toEqual([
      { checkId: "test", runs: 2, timeouts: 1, medianMs: 25 * MINUTE, p95Ms: 29.5 * MINUTE },
    ]);
  });
});

describe("GET /api/metrics/stages", () => {
  const url = (query: string) => new Request(`http://127.0.0.1:8787/api/metrics/stages?${query}`);

  test("refuses windows over 30 days, non-admins and bad repositories", async () => {
    const db = await store();
    const now = START;
    const status = async (query: string, role = "admin") =>
      (await handleMetricsRequest(url(query), { store: db, role, now }))!.status;
    expect(await status(`from=${now - 31 * 24 * 60 * MINUTE}&to=${now}`)).toBe(400);
    expect(await status(`from=${now - 30 * 24 * 60 * MINUTE}&to=${now}`)).toBe(200);
    expect(await status("", "member")).toBe(403);
    expect(await status("repository=acme")).toBe(400);
    expect(await status("repository=acme/app")).toBe(200);
  });
});
