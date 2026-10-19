import { expect, test } from "bun:test";
import { exhaustedChecks, parseCloseoutSkip } from "./ask-team";

test("request_closeout_skip needs check ids and a reason", () => {
  expect(parseCloseoutSkip({ checkIds: [" e2e ", "e2e", "unit"], reason: " Outage. " })).toEqual({
    checkIds: ["e2e", "unit"],
    reason: "Outage.",
  });
  expect(() => parseCloseoutSkip({ checkIds: [], reason: "Outage" })).toThrow("check ids");
  expect(() => parseCloseoutSkip({ checkIds: ["e2e; rm"], reason: "Outage" })).toThrow("check ids");
  expect(() => parseCloseoutSkip({ checkIds: ["e2e"], reason: " " })).toThrow("reason");
});

test("request_closeout_skip accepts exhausted commands and reviews, whose result Paws decides", () => {
  const report = JSON.stringify({
    required: [
      { id: "unit", kind: "command", status: "exhausted" },
      { id: "lint", kind: "command", status: "failed" },
      { id: "independent-review", kind: "review", status: "missing" },
    ],
  });
  expect(exhaustedChecks(report, ["unit", "independent-review"])).toEqual(["independent-review"]);
  expect(exhaustedChecks(report, ["unit"])).toEqual([]);
  expect(() => exhaustedChecks(report, ["lint"])).toThrow("only after its last attempt failed");
  expect(() => exhaustedChecks(report, ["e2e"])).toThrow("not required");
});
