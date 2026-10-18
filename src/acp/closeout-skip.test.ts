import { expect, test } from "bun:test";
import { parseCloseoutSkip } from "./ask-team";

test("request_closeout_skip needs check ids and a reason", () => {
  expect(parseCloseoutSkip({ checkIds: [" e2e ", "e2e", "unit"], reason: " Outage. " })).toEqual({
    checkIds: ["e2e", "unit"],
    reason: "Outage.",
  });
  expect(() => parseCloseoutSkip({ checkIds: [], reason: "Outage" })).toThrow("check ids");
  expect(() => parseCloseoutSkip({ checkIds: ["e2e; rm"], reason: "Outage" })).toThrow("check ids");
  expect(() => parseCloseoutSkip({ checkIds: ["e2e"], reason: " " })).toThrow("reason");
});
