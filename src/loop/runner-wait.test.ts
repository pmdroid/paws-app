import { expect, test } from "bun:test";
import type { RunnerAvailability } from "../db";
import { RUNNER_OFFLINE_MS, runnerWaitReason, waitForRunner } from "./runner-wait";

const goldbox: RunnerAvailability = {
  id: "runner-1",
  name: "goldbox",
  status: "active",
  revoked: false,
  lastSeenAt: 1_000,
};

test("a paused, revoked or offline runner has a waiting reason", () => {
  expect(runnerWaitReason(goldbox, 1_000)).toBeNull();
  expect(runnerWaitReason({ ...goldbox, status: "draining" }, 1_000)).toBeNull();
  expect(runnerWaitReason(null, 1_000)).toBeNull();
  expect(runnerWaitReason({ ...goldbox, status: "paused" }, 1_000)).toBe(
    "Waiting: runner goldbox is paused. Resume it on the Runners page.",
  );
  expect(runnerWaitReason({ ...goldbox, revoked: true }, 1_000)).toBe(
    "Waiting: runner goldbox is revoked. Pair it again on the Runners page.",
  );
  expect(runnerWaitReason(goldbox, 1_000 + RUNNER_OFFLINE_MS)).toBe(
    "Waiting: runner goldbox is offline. Start it again so it reconnects.",
  );
});

function harness(states: RunnerAvailability[], answers: string[] = []) {
  let now = 0;
  const shown: (string | null)[] = [];
  const notified: string[] = [];
  const asked: number[] = [];
  const cancelled: number[] = [];
  return {
    shown,
    notified,
    asked,
    cancelled,
    run: () =>
      waitForRunner({
        runner: () => states.shift() ?? goldbox,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        waiting: (reason) => shown.push(reason),
        notify: (reason) => notified.push(reason),
        ask: () => {
          const index = asked.push(now) - 1;
          const answer = answers[index];
          return {
            answer: answer === undefined ? new Promise<string>(() => {}) : Promise.resolve(answer),
            cancel: () => cancelled.push(index),
          };
        },
        askAfterMs: 30,
        pollMs: 10,
      }),
  };
}

const paused = { ...goldbox, status: "paused" as const, lastSeenAt: null };

test("an available runner is not held", async () => {
  const wait = harness([]);
  expect(await wait.run()).toBe("available");
  expect(wait.shown).toEqual([]);
  expect(wait.notified).toEqual([]);
});

test("a paused runner is shown once, asked about after the limit, and released on resume", async () => {
  const wait = harness(Array.from({ length: 6 }, () => paused));
  expect(await wait.run()).toBe("available");
  const reason = "Waiting: runner goldbox is paused. Resume it on the Runners page.";
  expect(wait.notified).toEqual([reason]);
  expect(wait.shown).toEqual([reason, null]);
  expect(wait.asked).toEqual([30]);
  expect(wait.cancelled).toEqual([0]);
});

test("keep waiting asks again after another wait; move ends the wait", async () => {
  const wait = harness(
    Array.from({ length: 20 }, () => paused),
    ["Keep waiting", "Move to another runner"],
  );
  expect(await wait.run()).toBe("move");
  expect(wait.asked).toEqual([30, 70]);
  expect(wait.cancelled).toEqual([]);
  expect(wait.shown.at(-1)).toBeNull();
});
