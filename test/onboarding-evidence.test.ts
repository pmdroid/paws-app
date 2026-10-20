import { expect, test } from "bun:test";
import { freshPermissionDenial } from "./local/onboarding-github";

const denied = {
  revision: 3,
  state: "waiting",
  reason: "github",
  memberGitHub: { state: "denied", reason: "permission" },
};

test("only a fresh explicit GitHub permission refusal establishes denied readiness", () => {
  expect(freshPermissionDenial(denied, 2, 0)).toBe(false);
  expect(freshPermissionDenial(denied, 3, 1)).toBe(false);
  expect(freshPermissionDenial(null, 2, 1)).toBe(false);
  expect(freshPermissionDenial({ ...denied, reason: "metadata", memberGitHub: null }, 2, 1)).toBe(
    false,
  );
  expect(freshPermissionDenial({ ...denied, reason: "agents" }, 2, 1)).toBe(false);
  expect(
    freshPermissionDenial(
      { ...denied, memberGitHub: { state: "ready", reason: "permission" } },
      2,
      1,
    ),
  ).toBe(false);
  expect(freshPermissionDenial(denied, 2, 1)).toBe(true);
});
