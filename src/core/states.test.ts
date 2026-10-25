import { describe, expect, test } from "bun:test";
import {
  IN_FLIGHT_ITEM_STATES,
  WORK_ITEM_STATES,
  holdsExecution,
  isBlockerSatisfied,
  type WorkItemState,
} from "./states";
import { TASK_MODES, type TaskMode } from "./task";

describe("isBlockerSatisfied", () => {
  const satisfied = new Set([
    "merged:code",
    "merged:answer",
    "merged:artifact",
    "merged:null",
    "completed:answer",
    "completed:artifact",
  ]);
  for (const state of WORK_ITEM_STATES)
    for (const mode of [...TASK_MODES, null] as (TaskMode | null)[])
      for (const mergeSha of [null, "", "merge-sha"]) {
        test(`${state} ${mode} blocker with merge SHA ${mergeSha}`, () => {
          expect(isBlockerSatisfied({ state, mode, mergeSha })).toBe(
            satisfied.has(`${state}:${mode}`) && (state !== "merged" || !!mergeSha),
          );
        });
      }
});

describe("holdsExecution", () => {
  const executing = new Set<WorkItemState>(["running", "verifying", "recovering"]);
  for (const state of WORK_ITEM_STATES) {
    test(`${state} without live work`, () => {
      expect(holdsExecution({ state, liveRun: false, liveJob: false })).toBe(executing.has(state));
    });
    test(`${state} with a live run or a live job`, () => {
      expect(holdsExecution({ state, liveRun: true, liveJob: false })).toBe(true);
      expect(holdsExecution({ state, liveRun: false, liveJob: true })).toBe(true);
      expect(holdsExecution({ state, liveRun: true, liveJob: true })).toBe(true);
      expect(holdsExecution({ state, liveRun: 1, liveJob: 0 })).toBe(true);
      expect(holdsExecution({ state, liveRun: 0, liveJob: 0 })).toBe(executing.has(state));
    });
  }
});

test("in-flight states", () => {
  expect([...IN_FLIGHT_ITEM_STATES]).toEqual([
    "running",
    "verifying",
    "recovering",
    "awaiting_input",
    "paused",
    "merge_queue",
  ]);
});
