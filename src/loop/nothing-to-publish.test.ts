import { expect, test } from "bun:test";
import { completesWithoutPull, keepsPull, saysNoChangeNeeded } from "./nothing-to-publish";

test("a final message that says no change is needed is told apart from other endings", () => {
  expect(saysNoChangeNeeded("This task needs no code change … PR #18 is still open.")).toBe(true);
  expect(saysNoChangeNeeded("No changes are needed; main already counts widgets.")).toBe(true);
  expect(saysNoChangeNeeded("Widgets are already counted per shelf; nothing to change.")).toBe(
    true,
  );
  expect(saysNoChangeNeeded("Rebased onto main and fixed the failing check.")).toBe(false);
  expect(saysNoChangeNeeded("")).toBe(false);
});

test("the open pull request answers complete or keep", () => {
  expect(completesWithoutPull({ answer: "Close the pull request and complete" })).toBe(true);
  expect(keepsPull({ answer: " keep the pull request and merge " })).toBe(true);
  expect(keepsPull({ answer: "Close the pull request and complete" })).toBe(false);
});
