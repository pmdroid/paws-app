import { expect, test } from "bun:test";
import { probeLinearProjectMembers } from "./local/linear-project-members";

test("Runner sharing reads canonical project membership and issue ownership", async () => {
  const observations: boolean[] = [];
  await probeLinearProjectMembers((_name, passed) => observations.push(passed));
  expect(observations).toHaveLength(4);
  expect(observations.every(Boolean)).toBe(true);
});
