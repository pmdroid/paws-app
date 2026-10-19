import { expect, test } from "bun:test";
import { recoveryQuestion } from "./closeout-recovery";

const recovery = {
  taskId: "PAS-357-task",
  itemId: "item",
  base: "2f177c50aaf08733917288514163a75c76062e0e",
  head: "664ca6a91a4eaa9a8819600ee209b9e9dde97fae",
  policyDigest: "",
  failedChecks: [],
  retryBaseline: [],
};

test("a policy field this Paws does not know asks for a Paws update", () => {
  const body = recoveryQuestion({
    ...recovery,
    summary:
      "Closeout: blocked\nMessage: .agents/closeout.yaml: /retry must NOT have additional properties ('maxFailedReviewAttempts' was unexpected)",
  });
  expect(body).toContain(
    "The Closeout policy on origin/main uses `maxFailedReviewAttempts`, which this version of Paws does not support. Update Paws, then reply retry.",
  );
});

test("other blocked policies keep the usual question", () => {
  const body = recoveryQuestion({
    ...recovery,
    summary: "Closeout: blocked\nMessage: invalid YAML",
  });
  expect(body).not.toContain("Update Paws");
  expect(body).toContain("Reply with guidance");
});
