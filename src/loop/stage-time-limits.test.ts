import { expect, test } from "bun:test";
import { parseConfigToml, resolveTimeLimits } from "../config";
import { DEFAULT_MAX_AWAKE_MS, FakeClock, JOB_KIND, type RestartReason } from "../core";
import {
  accrueAwake,
  applyWorkItemEvent,
  beginImplementRun,
  claimNextJob,
  enqueueJob,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  migrate,
  openDatabase,
  sqliteDb,
} from "../db";
import { startFreshBudgetSteps } from "./time-budget";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

async function harness(toml: string, projectId: string | null = null) {
  const clock = new FakeClock(20_000);
  const db = openDatabase(":memory:");
  migrate(db);
  const config = parseConfigToml(toml);
  const limits = resolveTimeLimits(config, projectId, config.maxAwakeMs ?? DEFAULT_MAX_AWAKE_MS);
  const item = insertQueuedItem(db, { id: "eng-1", sessionKey: "ses", limits, now: clock.now() });
  await beginImplementRun(sqliteDb(db), item.id, clock.now());
  await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now(), undefined, true);
  const work = async (ms: number, reason?: RestartReason) => {
    if (reason) {
      applyWorkItemEvent(db, item.id, "restart", { kind: "restart", reason });
      applyWorkItemEvent(db, item.id, "dispatched");
      await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now(), undefined, true);
    }
    clock.advance(ms);
    return await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now(), undefined, true);
  };
  const question = () =>
    (listJobs(db).find((job) => job.queue === "item.ask")?.payload as { body: string } | undefined)
      ?.body;
  return { clock, db, id: item.id, limits, work, question };
}

test("3 h of implementation and 2 h of CI fixes reach only the implementation limit, at 3 h", async () => {
  const { db, id, work, question } = await harness("[time_limits]\nimplementation_minutes = 180\n");
  expect((await work(2 * HOUR)).asked).toBeUndefined();
  expect((await work(2 * HOUR, "ci")).asked).toBeUndefined();
  expect(getWorkItem(db, id)).toMatchObject({ implementMs: 2 * HOUR, fixMs: 2 * HOUR });
  expect((await work(HOUR - 1, "follow_up")).asked).toBeUndefined();
  expect((await work(1)).asked).toBe(true);
  expect(question()).toStartWith("Implementation reached its 3 h limit; continue or stop?");
  expect(question()).toContain("Counted: implementation 3 h. Not counted: fixes 2 h.");
});

test("with fixes_minutes = 60, the second hour of fixes asks and names the fixes stage", async () => {
  const { db, id, work, question } = await harness("[time_limits]\nfixes_minutes = 60\n");
  expect((await work(30 * MINUTE)).asked).toBeUndefined();
  expect((await work(59 * MINUTE, "review")).asked).toBeUndefined();
  expect((await work(MINUTE)).asked).toBe(true);
  expect(question()).toStartWith("The fixes stage reached its 1 h limit; continue or stop?");

  await sqliteDb(db).transaction((q) =>
    startFreshBudgetSteps(q, { itemId: id, sessionId: null, key: "q", stage: "fixes", now: 0 }),
  );
  expect(getWorkItem(db, id)).toMatchObject({
    implementMs: 30 * MINUTE,
    fixMs: 0,
    maxFixMs: HOUR,
  });
});

test("Closeout time does not count by default", async () => {
  const { clock, db, id, work } = await harness("");
  await work(10 * MINUTE);
  applyWorkItemEvent(db, id, "turn_ended");
  enqueueJob(db, { queue: JOB_KIND.reverify, payload: { itemId: id }, now: clock.now() });
  claimNextJob(db, { now: clock.now(), leaseMs: 24 * HOUR, queues: [JOB_KIND.reverify] });
  await accrueAwake(sqliteDb(db), id, clock.mono(), clock.now());
  clock.advance(5 * HOUR);
  const result = await accrueAwake(sqliteDb(db), id, clock.mono(), clock.now());
  expect(result.asked).toBeUndefined();
  expect(result.item).toMatchObject({ state: "verifying", closeoutMs: 5 * HOUR });
});

test("without [time_limits], max_awake_ms limits implementation and nothing else", async () => {
  const { limits, work, question } = await harness("[caps]\nmax_awake_ms = 3600000\n");
  expect(limits).toEqual({ implementation: HOUR, fixes: 0, closeout: 0 });
  expect((await work(3 * HOUR, "ci")).asked).toBeUndefined();
  expect((await work(HOUR, "answer")).asked).toBe(true);
  expect(question()).toStartWith("Implementation reached its 1 h limit");
});

test("a per-project override wins over [time_limits]", async () => {
  const toml = [
    "[caps]",
    "max_awake_ms = 3600000",
    "[time_limits]",
    "implementation_minutes = 120",
    "fixes_minutes = 0",
    '[time_limits.projects."proj-1"]',
    "fixes_minutes = 30",
  ].join("\n");
  const config = parseConfigToml(toml);
  expect(resolveTimeLimits(config, "proj-1", HOUR)).toEqual({
    implementation: 2 * HOUR,
    fixes: 30 * MINUTE,
    closeout: 0,
  });
  expect(resolveTimeLimits(config, "proj-2", HOUR)).toEqual({
    implementation: 2 * HOUR,
    fixes: 0,
    closeout: 0,
  });
  const { work, question } = await harness(toml, "proj-1");
  expect((await work(30 * MINUTE, "conflict")).asked).toBe(true);
  expect(question()).toStartWith("The fixes stage reached its 30 min limit");
});
