import { expect, test } from "bun:test";
import { closeoutTransferFault, reviewerProfileFault, SystemFault } from "./system-fault";

test("reviewer setup classification does not capture candidate files or API output", () => {
  for (const error of [
    Object.assign(new Error("open evidence.json"), { code: "ENOENT" }),
    Object.assign(new Error("missing worktree"), { code: "ENOENT" }),
    new Error("model not available"),
    new Error("not authenticated"),
    new Error("unknown command in candidate script"),
  ])
    expect(reviewerProfileFault(error)).toBeNull();
  expect(reviewerProfileFault(new Error("codex: command not found"))?.faultClass).toBe(
    "reviewer-profile",
  );
  expect(reviewerProfileFault(new Error("Reviewer login is missing"))?.faultClass).toBe(
    "reviewer-profile",
  );
});

test("a crashed checks worker is not a policy transfer failure", () => {
  expect(closeoutTransferFault(new Error("worker exited without a result"))).toBeNull();
  expect(closeoutTransferFault(new Error("runner is offline"))).toBeNull();
  expect(closeoutTransferFault(new Error("candidate payload exceeds assertion limit"))).toBeNull();
  expect(closeoutTransferFault(new Error("Runner bundle exceeds size limit"))?.faultClass).toBe(
    "closeout-transfer",
  );
  const typed = new SystemFault("closeout-transfer", "policy transfer failed");
  expect(closeoutTransferFault(typed)).toBe(typed);
});
