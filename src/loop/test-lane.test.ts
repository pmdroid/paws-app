import { expect, test } from "bun:test";
import type { TestPermit } from "../db";
import { TEST_LANE_ASK_MS, testLaneWaitReason, waitForTestLane } from "./test-lane";

function lane(permits: TestPermit[], options: { needed?: boolean[] } = {}) {
  const calls: string[] = [];
  let now = 0;
  const input = {
    runner: "astra",
    needed: async () => {
      calls.push("needed");
      return options.needed?.shift() ?? true;
    },
    take: async () => {
      calls.push("take");
      return permits.shift() ?? permits[0] ?? { granted: false, holder: "run-a" };
    },
    release: async () => {
      calls.push("release");
    },
    holder: async (runId: string) => (runId === "run-a" ? "PAS-1" : runId),
    waiting: (reason: string | null) => {
      calls.push(`waiting:${reason}`);
    },
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
      calls.push("sleep");
    },
    pollMs: 60_000,
  };
  return { input, calls };
}

test("a waiter takes the permit once the holder ends, and says why it waited", async () => {
  const { input, calls } = lane([
    { granted: false, holder: "run-a" },
    { granted: false, holder: "run-a" },
    { granted: true },
  ]);
  expect(await waitForTestLane(input)).toBe(true);
  expect(calls.filter((call) => call === "take")).toHaveLength(3);
  expect(calls.filter((call) => call.startsWith("waiting:"))).toEqual([
    `waiting:${testLaneWaitReason("astra")}`,
    "waiting:null",
  ]);
  expect(testLaneWaitReason("astra")).toContain("waiting for the test lane on astra");
  expect(calls).not.toContain("release");
});

test("a waiter rechecks the policy on wake and leaves the queue when no test check runs", async () => {
  const { input, calls } = lane([{ granted: false, holder: "run-a" }], {
    needed: [true, false],
  });
  expect(await waitForTestLane(input)).toBe(false);
  expect(calls.slice(-2)).toEqual(["release", "waiting:null"]);
});

test("a waiter past 2 hours asks once, naming the holder, and leaves the queue", async () => {
  const { input, calls } = lane([]);
  const error = await waitForTestLane(input).catch((caught: Error) => caught);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(
    "Closeout waited 2 hours for the test lane on astra, which PAS-1 holds.",
  );
  expect(calls.filter((call) => call === "sleep")).toHaveLength(TEST_LANE_ASK_MS / 60_000);
  expect(calls.filter((call) => call === "release")).toHaveLength(1);
});

test("a stale head stops the wait and frees the place in the queue", async () => {
  const { input, calls } = lane([{ granted: false, holder: "run-a" }]);
  let checks = 0;
  input.needed = async () => {
    if (++checks > 1) throw new Error("stale head");
    return true;
  };
  await expect(waitForTestLane(input)).rejects.toThrow("stale head");
  expect(calls).toContain("release");
});
