import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { applyWorkItemEvent, insertQueuedItem, migrate, openDatabase } from "../../../db";
import type { WorkItemEvent } from "../../../core";
import { parseStatusSnapshot, type StatusSnapshot } from "../contract";
import { createLiveStatusProvider } from "./provider";
import { stateTotals } from "./state-times";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-10-28T00:00:00.000Z");

const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function database(): Database {
  const db = openDatabase(":memory:");
  migrate(db);
  open.push(db);
  return db;
}

function snapshot(db: Database, now: number): StatusSnapshot {
  const provider = createLiveStatusProvider(db, { now: () => new Date(now), env: {} });
  const parsed = parseStatusSnapshot(JSON.parse(JSON.stringify(provider.snapshot())));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.snapshot;
}

/** Applies each event `minutes` after `start`. */
function walk(
  db: Database,
  id: string,
  start: number,
  steps: [number, WorkItemEvent, ("restart" | "ask")?][],
): void {
  for (const [minutes, event, kind] of steps) {
    const now = start + minutes * MIN;
    if (kind === "restart") applyWorkItemEvent(db, id, event, { kind, reason: "findings", now });
    else if (kind === "ask") applyWorkItemEvent(db, id, event, { kind, reason: "budget", now });
    else applyWorkItemEvent(db, id, event, { now });
  }
}

function minutesByState(states: { state: string; ms: number }[]): Record<string, number> {
  return Object.fromEntries(states.map((entry) => [entry.state, entry.ms / MIN]));
}

describe("state times", () => {
  test("an item with a crash, a question, a rejected Closeout and a restart: its states add up to its age", () => {
    const db = database();
    insertQueuedItem(db, { id: "PAS-1", now: T0 });
    walk(db, "PAS-1", T0, [
      [10, "dispatched"],
      [30, "lease_expired"],
      [50, "recovered"],
      [60, "blocking_question", "ask"],
      [80, "answer_received"],
      [90, "turn_ended"],
      [95, "closeout_rejected"],
      [100, "restart", "restart"],
      [110, "dispatched"],
      [120, "turn_ended"],
      [125, "closeout_accepted"],
    ]);

    const item = snapshot(db, T0 + 140 * MIN).items.find((entry) => entry.id === "PAS-1")!;
    const times = item.stateTimes!;
    expect(times.since).toBe(new Date(T0).toISOString());
    expect(times.until).toBe(new Date(T0 + 140 * MIN).toISOString());
    expect(times.current).toBe("merge_queue");
    expect(minutesByState(times.states)).toEqual({
      queued: 20,
      running: 55,
      recovering: 20,
      awaiting_input: 20,
      verifying: 10,
      merge_queue: 15,
    });
    const total = times.states.reduce((sum, entry) => sum + entry.ms, 0);
    expect(total).toBe(Date.parse(times.until) - Date.parse(times.since));
  });

  test("the current state counts up to now and a merged item stops at its merge", () => {
    const db = database();
    insertQueuedItem(db, { id: "PAS-2", now: T0 });
    walk(db, "PAS-2", T0, [[5, "dispatched"]]);
    const at = (now: number) =>
      snapshot(db, now).items.find((entry) => entry.id === "PAS-2")!.stateTimes!;
    expect(minutesByState(at(T0 + 20 * MIN).states)).toEqual({ queued: 5, running: 15 });
    expect(minutesByState(at(T0 + 50 * MIN).states)).toEqual({ queued: 5, running: 45 });

    walk(db, "PAS-2", T0, [
      [60, "turn_ended"],
      [62, "closeout_accepted"],
      [70, "merge_accepted"],
    ]);
    const merged = at(T0 + 5 * HOUR);
    expect(merged.current).toBeNull();
    expect(merged.until).toBe(new Date(T0 + 70 * MIN).toISOString());
    expect(minutesByState(merged.states)).toEqual({
      queued: 5,
      running: 55,
      verifying: 2,
      merge_queue: 8,
    });
  });

  test("an item without state changes spends its whole age in its current state", () => {
    const totals = stateTotals(T0, [], "queued", T0 + 7 * MIN);
    expect([...totals.states]).toEqual([["queued", 7 * MIN]]);
  });

  test("the last 24 hours: median and p90 from start to merge and the average per state", () => {
    const db = database();
    const now = T0 + 24 * HOUR;
    // Ten items merged today, taking 10, 20, … 100 minutes: queued 5, verifying 2, merge queue 1.
    for (let k = 1; k <= 10; k += 1) {
      const id = `PAS-${100 + k}`;
      const start = T0 + k * HOUR;
      const age = 10 * k;
      insertQueuedItem(db, { id, now: start });
      walk(db, id, start, [
        [5, "dispatched"],
        [age - 3, "turn_ended"],
        [age - 1, "closeout_accepted"],
        [age, "merge_accepted"],
      ]);
    }
    // Merged 25 hours ago, outside the window.
    insertQueuedItem(db, { id: "PAS-90", now: now - 30 * HOUR });
    walk(db, "PAS-90", now - 30 * HOUR, [
      [5, "dispatched"],
      [100, "turn_ended"],
      [200, "closeout_accepted"],
      [300, "merge_accepted"],
    ]);
    // Still open.
    insertQueuedItem(db, { id: "PAS-91", now: T0 });
    walk(db, "PAS-91", T0, [[5, "dispatched"]]);

    const times = snapshot(db, now).mergedTimes!;
    expect(times.since).toBe(new Date(T0).toISOString());
    expect(times.merged).toBe(10);
    // Sorted ages 10 … 100: the median is (50 + 60) / 2, the nearest-rank p90 the 9th.
    expect(times.medianMs).toBe(55 * MIN);
    expect(times.p90Ms).toBe(90 * MIN);
    // Running is age - 8, averaging 55 - 8.
    expect(times.states).toEqual([
      { state: "running", ms: 47 * MIN },
      { state: "queued", ms: 5 * MIN },
      { state: "verifying", ms: 2 * MIN },
      { state: "merge_queue", ms: 1 * MIN },
    ]);
  });

  test("no merged times while nothing merged in the last 24 hours", () => {
    const db = database();
    insertQueuedItem(db, { id: "PAS-3", now: T0 });
    expect(snapshot(db, T0 + HOUR).mergedTimes).toBeUndefined();
  });
});
