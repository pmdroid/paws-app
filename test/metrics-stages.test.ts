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

async function seedItem(
  db: Db,
  id: string,
  states: [string, number][],
  repo: string | null = "app",
) {
  await db.run(function* (q: Q) {
    yield* insertWorkItemSteps(q, id, START);
    if (repo)
      yield* q.exec(
        q.orm.insert(q.t.workItemRepository).values({
          itemId: id,
          owner: "acme",
          repo,
          remoteUrl: `https://github.com/acme/${repo}`,
        }),
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

async function seedCheck(
  db: Db,
  progressId: string,
  minutes: number,
  timedOut = 0,
  check: { itemId?: string; stepId?: string; exitCode?: number | null } = {},
) {
  await db.run(function* (q: Q) {
    yield* q.exec(
      q.orm.insert(q.t.closeoutProgress).values({
        id: progressId,
        itemId: check.itemId ?? "item-a",
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
        stepId: check.stepId ?? "test",
        kind: "command",
        state: "passed",
        command: "bun test",
        attempt: 1,
        ordinal: 0,
        startedAt: START,
        finishedAt: START + minutes * MINUTE,
        timedOut,
        exitCode: check.exitCode ?? null,
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

  test("counts items with no events in the window and never overlaps question waits", async () => {
    const db = await store();
    await seedItem(db, "item-a", [
      ["merge_queue", 0],
      ["merged", 20 * 60],
    ]);
    await seedItem(db, "item-b", []);
    await seedItem(db, "item-c", [
      ["awaiting_input", 0],
      ["running", 60],
    ]);
    for (const [id, minutes] of [
      ["q1", 0],
      ["q2", 10],
    ] as const)
      await db.run((q) =>
        q.exec(
          q.orm.insert(q.t.question).values({
            id,
            itemId: "item-c",
            sessionId: id,
            body: "?",
            status: "answered",
            createdAt: START + minutes * MINUTE,
            answeredAt: START + (minutes + 30) * MINUTE,
          }),
        ),
      );
    const report = await readStageTimes(db, {
      ...WINDOW,
      from: START + 60 * MINUTE,
      to: START + 120 * MINUTE,
    });
    const byId = new Map(report.items.map((item) => [item.itemId, item]));
    expect(byId.get("item-a")!.stagesMs.mergeQueue).toBe(60 * MINUTE);
    expect(byId.get("item-b")!.stagesMs.queued).toBe(60 * MINUTE);
    const early = await readStageTimes(db, { ...WINDOW, from: START, to: START + 120 * MINUTE });
    const c = early.items.find((item) => item.itemId === "item-c")!;
    expect(c.waitingForPerson.map((wait) => wait.ms)).toEqual([30 * MINUTE, 10 * MINUTE]);
    expect(c.waitingForPersonMs).toBeLessThanOrEqual(c.stagesMs.awaitingInput);
  });

  test("reports the median and p95 of each Closeout check with timeouts", async () => {
    const db = await store();
    await seedItem(db, "item-a", []);
    await seedCheck(db, "p1", 20);
    await seedCheck(db, "p2", 30, 1);
    const report = await readStageTimes(db, WINDOW);
    expect(report.checks).toEqual([
      {
        checkId: "test",
        runs: 2,
        failures: 0,
        timeouts: 1,
        medianMs: 25 * MINUTE,
        p95Ms: 29.5 * MINUTE,
      },
    ]);
  });

  test("breaks items and Closeout checks down per repository", async () => {
    const db = await store();
    await seedItem(db, "item-a", [
      ["running", 10],
      ["verifying", 20],
      ["merge_queue", 10],
      ["merged", 5],
    ]);
    await seedItem(db, "item-b", [
      ["running", 30],
      ["verifying", 40],
      ["running", 10],
      ["verifying", 10],
      ["failed", 10],
    ]);
    await seedItem(db, "item-c", [["running", 0]], "web");
    await seedItem(db, "item-d", [], null);
    await seedCheck(db, "p1", 10, 0, { exitCode: 0 });
    await seedCheck(db, "p2", 20, 0, { itemId: "item-b", exitCode: 1 });
    await seedCheck(db, "p3", 30, 1, { itemId: "item-b", exitCode: 1 });
    await seedCheck(db, "p4", 40, 0, { itemId: "item-b", stepId: "lint", exitCode: 0 });
    await seedCheck(db, "p5", 5, 0, { itemId: "item-c", exitCode: 2 });
    await seedCheck(db, "p6", 7, 0, { itemId: "item-d", exitCode: 3 });
    const report = await readStageTimes(db, { ...WINDOW, now: START + 100 * MINUTE });
    expect(report.items.map((item) => item.itemId)).toContain("item-d");
    expect(report.total.turns).toBe(4);
    expect(report.checks.find((check) => check.checkId === "test")).toMatchObject({
      runs: 5,
      failures: 3,
      timeouts: 1,
    });
    expect(report.repositories).toEqual([
      {
        repository: "acme/app",
        issues: 2,
        merged: 1,
        medianTotalMs: 72.5 * MINUTE,
        medianStagesMs: {
          queued: 20 * MINUTE,
          running: 35 * MINUTE,
          verifying: 15 * MINUTE,
          awaitingInput: 0,
          mergeQueue: 2.5 * MINUTE,
        },
        medianMergeWaitMs: { review: 0, githubQueue: 0, unclassified: 2.5 * MINUTE },
        medianWaitingForPersonMs: 0,
        avgCloseoutRounds: 1.5,
        avgTurns: 1.5,
        checkRuns: 4,
        checkFailures: 1,
        checkTimeouts: 1,
        slowestCheck: { checkId: "lint", medianMs: 40 * MINUTE },
      },
      {
        repository: "acme/web",
        issues: 1,
        merged: 0,
        medianTotalMs: 100 * MINUTE,
        medianStagesMs: {
          queued: 0,
          running: 100 * MINUTE,
          verifying: 0,
          awaitingInput: 0,
          mergeQueue: 0,
        },
        medianMergeWaitMs: { review: 0, githubQueue: 0, unclassified: 0 },
        medianWaitingForPersonMs: 0,
        avgCloseoutRounds: 0,
        avgTurns: 1,
        checkRuns: 1,
        checkFailures: 1,
        checkTimeouts: 0,
        slowestCheck: { checkId: "test", medianMs: 5 * MINUTE },
      },
    ]);
    const web = await readStageTimes(db, {
      ...WINDOW,
      now: START + 100 * MINUTE,
      repository: { owner: "acme", repo: "web" },
    });
    expect(web.repositories.map((row) => row.repository)).toEqual(["acme/web"]);
    expect(web.items.map((item) => item.itemId)).toEqual(["item-c"]);
    expect(web.checks).toMatchObject([{ checkId: "test", runs: 1, failures: 1 }]);
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
