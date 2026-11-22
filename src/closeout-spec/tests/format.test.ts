import { expect, test } from "bun:test";
import { fittedTests, storedFailedTests, storedTestSelection } from "./index";

test("fitted tests keep the failures and reasons that fit the byte budget", () => {
  const failures = Array.from({ length: 70 }, (_, index) => ({
    file: `t${index}.test.ts`,
    message: "x".repeat(5_000),
    kind: "failed" as const,
  }));
  const selection = storedTestSelection({ mode: "full", reasons: ["a changed"] }, "");
  const fitted = fittedTests(storedFailedTests(failures), selection, 100_000);
  expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(100_000);
  expect(fitted.failedTests.total).toBe(70);
  expect(fitted.failedTests.shown.length).toBe(24);
  expect(fitted.failedTests.shown[0]?.message.length).toBe(4_000);
  expect(fitted.testSelection).toEqual({
    mode: "full",
    reasons: ["a changed"],
    selected: 0,
    base: "",
  });
});
