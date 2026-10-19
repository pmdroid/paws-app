import { expect, test } from "bun:test";
import { parseRecoveryAnswer, recoveryQuestion } from "./closeout-recovery";

const recovery = {
  taskId: "ENG-1-task",
  itemId: "item",
  base: "a".repeat(40),
  head: "b".repeat(40),
  policyDigest: "digest",
  failedChecks: ["e2e", "lint"],
  retryBaseline: [],
  summary: "Closeout: exhausted\n- e2e (command): exhausted attempt 3",
  skipRequest: { checks: ["e2e"], reason: "The runner has no display." },
};

test("the recovery comment shows the checks, the agent's reason and its evidence links", () => {
  const body = recoveryQuestion(recovery, undefined, [
    { checkId: "e2e", label: "run [1].webm", video: true, url: "https://paws.test/evidence/E1" },
    { checkId: "e2e", label: "end.png", video: false, url: "https://paws.test/evidence/E2" },
    { checkId: "lint", label: "lint.webm", video: true, url: "https://paws.test/evidence/E3" },
  ]);
  expect(body).toContain("- e2e (command): exhausted attempt 3");
  expect(body).toContain("The agent asks to skip `e2e`.\nReason: The runner has no display.");
  expect(body).toContain("- Video for `e2e`: [run \\[1\\].webm](<https://paws.test/evidence/E1>)");
  expect(body).toContain("- Screenshot for `e2e`: [end.png](<https://paws.test/evidence/E2>)");
  expect(body).not.toContain("E3");
  expect(body).toContain("Checks you can bypass for this exact candidate: e2e, lint.");
  expect(body).toContain("/paws bypass check-id,other-check-id -- your reason");
});

test("without a skip request the recovery comment is unchanged", () => {
  const body = recoveryQuestion({ ...recovery, skipRequest: null });
  expect(body).not.toContain("The agent asks to skip");
});

test("the agent's reason does not approve a bypass; only a person's reply does", () => {
  expect(parseRecoveryAnswer(recovery.skipRequest.reason, recovery.failedChecks)).toEqual({
    kind: "guidance",
    body: "The runner has no display.",
  });
});
