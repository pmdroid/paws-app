import { expect, test } from "bun:test";
import {
  insertQueuedItem,
  listCiRounds,
  markCiRound,
  migrate,
  openDatabase,
  recordCiChecks,
  type CiRoundCheck,
} from "./index";

const check = (name: string, state: CiRoundCheck["state"], log: string | null = null) => ({
  name,
  state,
  url: `https://ci.example/${name}`,
  startedAt: null,
  completedAt: null,
  log: log === null ? null : { source: "actions" as const, text: log },
});

test("a CI round per head keeps its start, takes the latest checks and records what Paws did", () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const item = insertQueuedItem(db, { id: "ENG-1" });
  const base = {
    itemId: item.id,
    runId: "run-1",
    pullNumber: 7,
    pullUrl: "https://github.com/o/r/pull/7",
  };
  recordCiChecks(db, { ...base, head: "a", checks: [check("test", "running")], now: 10 });
  recordCiChecks(db, {
    ...base,
    head: "a",
    checks: [check("test", "failed", "1 fail")],
    now: 20,
  });
  // A later read of the same head without a log keeps the tail it already has.
  recordCiChecks(db, {
    ...base,
    runId: null,
    head: "a",
    checks: [check("test", "failed")],
    now: 30,
  });
  markCiRound(db, {
    itemId: item.id,
    head: "a",
    next: "agent",
    fixAttempt: 1,
    fixLimit: 3,
    now: 40,
  });
  recordCiChecks(db, { ...base, head: "b", checks: [check("test", "passed")], now: 50 });

  const rounds = listCiRounds(db, [item.id]);
  expect(rounds.map((round) => [round.head, round.startedAt, round.updatedAt])).toEqual([
    ["a", 10, 40],
    ["b", 50, 50],
  ]);
  expect(rounds[0]).toMatchObject({
    runId: "run-1",
    pullNumber: 7,
    next: "agent",
    fixAttempt: 1,
    fixLimit: 3,
  });
  expect(rounds[0]!.checks).toEqual([check("test", "failed", "1 fail")]);
  expect(rounds[1]).toMatchObject({ next: null, fixAttempt: null, fixLimit: null });
  expect(listCiRounds(db, [])).toEqual([]);
  db.close();
});
