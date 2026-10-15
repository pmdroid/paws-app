import { expect, test } from "bun:test";
import { tempHome } from "./helpers";
import { probeResponseTaskRecovery } from "./local/response-task-recovery";

test("response tasks finish after a real SQLite restart without a Git checkpoint", async () => {
  const observations = await probeResponseTaskRecovery(tempHome());
  expect(observations).toHaveLength(2);
  expect(observations.every((entry) => entry.passed)).toBe(true);
}, 15000);
