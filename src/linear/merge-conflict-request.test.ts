import { expect, test } from "bun:test";
import { isMergeConflictRequest } from "./merge-conflict-request";

test("a request to fix or resolve merge conflicts is recognized", () => {
  expect(isMergeConflictRequest("Fix merge conflicts")).toBe(true);
  expect(isMergeConflictRequest("Please resolve the merge conflicts in this pull request.")).toBe(
    true,
  );
  expect(isMergeConflictRequest("fix the merge-conflict with main")).toBe(true);
});

test("other replies are not a merge-conflict request", () => {
  expect(isMergeConflictRequest("Also cover the empty state")).toBe(false);
  expect(isMergeConflictRequest("Merge conflicts are fine, fix the typo instead.")).toBe(false);
});
