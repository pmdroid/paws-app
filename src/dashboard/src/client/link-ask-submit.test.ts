import { expect, test } from "bun:test";
import { linkAskBody } from "./link-ask-submit";

const base = { questionId: "q", note: "", ruleReason: "", bypasses: [] };

test("approving a rule sends its reason as the note the server requires", () => {
  expect(
    linkAskBody({
      ...base,
      decision: "approve",
      rule: "api-contract",
      ruleReason: "gated by runner version",
      bypassing: true,
      bypasses: [{ checkId: "api-contract", reason: "gated by runner version" }],
    }),
  ).toEqual({ questionId: "q", decision: "approve", note: "gated by runner version" });
});

test("sending a rule back keeps its reason as the note", () => {
  expect(
    linkAskBody({
      ...base,
      decision: "changes",
      rule: "api-contract",
      ruleReason: "fix it",
      bypassing: false,
    }),
  ).toEqual({ questionId: "q", decision: "changes", note: "fix it" });
});

test("a check bypass sends the chosen checks and no note", () => {
  const bypasses = [{ checkId: "lint", reason: "flaky" }];
  expect(
    linkAskBody({ ...base, decision: "approve", rule: undefined, bypassing: true, bypasses }),
  ).toEqual({ questionId: "q", decision: "approve", note: "", bypasses });
});

test("any other decision sends the typed note", () => {
  expect(
    linkAskBody({ ...base, decision: "answer", note: "go", rule: undefined, bypassing: false }),
  ).toEqual({ questionId: "q", decision: "answer", note: "go" });
});
