import { describe, expect, test } from "bun:test";
import { parseRecoveryAnswer, recoveryQuestion } from "./closeout-recovery";

const recovery = {
  taskId: "ENG-1-01",
  itemId: "item-1",
  base: "a".repeat(40),
  head: "b".repeat(40),
  policyDigest: "sha256:policy",
  failedChecks: ["e2e", "unit"],
  retryBaseline: [],
  summary: "Closeout: exhausted",
};

describe("Closeout recovery question", () => {
  test("shows the agent's skip request with its reason and evidence links", () => {
    const body = recoveryQuestion({
      ...recovery,
      skip: {
        checkIds: ["e2e"],
        reason: "The staging browser is down.",
        evidence: [
          { label: "e2e: checkout [mobile].webm", url: "https://paws.example/evidence/01ABC" },
        ],
      },
    });
    expect(body).toContain("The agent asks to skip e2e after the last attempt failed.");
    expect(body).toContain("Reason: The staging browser is down.");
    expect(body).toContain(
      "- [e2e: checkout \\[mobile\\].webm](<https://paws.example/evidence/01ABC>)",
    );
    expect(body).toContain("Checks you can bypass for this exact candidate: e2e, unit.");
    expect(body).toContain("/paws bypass check-id,other-check-id -- your reason");
  });

  test("leaves the skip section out when the agent did not ask", () => {
    expect(recoveryQuestion({ ...recovery, skip: null })).not.toContain("The agent asks to skip");
  });

  test("bypass and guidance replies parse as before", () => {
    expect(
      parseRecoveryAnswer("/paws bypass e2e -- Staging outage", recovery.failedChecks),
    ).toEqual({ kind: "bypass", checkIds: ["e2e"], reason: "Staging outage" });
    expect(parseRecoveryAnswer("Mock the browser instead", recovery.failedChecks)).toEqual({
      kind: "guidance",
      body: "Mock the browser instead",
    });
  });
});
