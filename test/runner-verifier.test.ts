import { expect, test } from "bun:test";
import { probeRunnerVerifier } from "./local/runner-verifier";

test("native Ed25519 verifier rejects altered or ambiguously encoded trusted evidence", () => {
  const observations: boolean[] = [];
  probeRunnerVerifier((_name, passed) => observations.push(passed));
  expect(observations).toEqual([true, true, true, true, true]);
});
