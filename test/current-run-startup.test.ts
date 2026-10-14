import { expect, test } from "bun:test";
import { tempHome } from "./helpers";
import { probeCurrentRunStartup } from "./local/current-run-startup";

test("new code and artifact runs persist a GitHub hold against the actual current run", async () => {
  const observations = await probeCurrentRunStartup(tempHome());
  expect(observations).toHaveLength(2);
  expect(observations.every((entry) => entry.passed)).toBe(true);
});
