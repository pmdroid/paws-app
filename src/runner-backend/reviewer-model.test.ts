import { expect, test } from "bun:test";
import { reviewerModelDeadEnd } from "./index";

const matches = "reviewer model matches implementation model";

test("every runner refusing the implementation model is a dead end", () => {
  expect(reviewerModelDeadEnd([`agentbox: ${matches}`, `boat: ${matches}`])).toBe(true);
  expect(
    reviewerModelDeadEnd([`agentbox: ${matches}`, "boat: run pinned to another online runner"]),
  ).toBe(true);
});

test("a busy, offline or empty runner set still waits", () => {
  expect(reviewerModelDeadEnd([])).toBe(false);
  expect(reviewerModelDeadEnd([`agentbox: ${matches}`, "boat: offline"])).toBe(false);
  expect(
    reviewerModelDeadEnd([`agentbox: ${matches}`, "boat: no free capacity (work 1 of 1)"]),
  ).toBe(false);
});
