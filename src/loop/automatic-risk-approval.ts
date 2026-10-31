import type { Database } from "bun:sqlite";
import { HIGH_RISK_PATHS_FILE } from "../core";
import {
  getCloseoutProgress,
  getCandidatePaths,
  listReviewFindings,
  type CandidateRisk,
} from "../db";

/** Exact-head evidence only. Reads stored rows without changing the gate or recording approval. */
export function automaticRiskApproval(
  db: Database,
  risk: CandidateRisk,
  input: {
    autoApproveHighRisk?: boolean;
    policyDigest?: string | null;
    policyPaths?: readonly string[] | null;
  },
): { eligible: boolean; detail: string } {
  const manual = (reason: string) => ({
    eligible: false,
    detail: `Manual approval required: ${reason}`,
  });
  if (!input.autoApproveHighRisk) return manual("automatic approval is off");
  if (risk.tier !== "high") return manual("risk is not high");
  const { policyDigest, policyPaths } = input;
  if (policyDigest == null || policyPaths == null) return manual("policy evidence is unavailable");
  const run = getCloseoutProgress(db, risk.itemId, risk.head);
  if (
    run?.decision !== "accepted" ||
    run.finishedAt === null ||
    run.base !== risk.base ||
    run.policyDigest !== policyDigest
  )
    return manual("Closeout has not accepted this head and policy");
  const paths = getCandidatePaths(db, risk.itemId, risk.head);
  if (
    paths === null ||
    paths.some(
      (path) =>
        path === HIGH_RISK_PATHS_FILE ||
        policyPaths.includes(path) ||
        path
          .toLowerCase()
          .split("/")
          .some((part) =>
            [
              ".agents",
              ".claude",
              ".codex",
              ".cursor",
              "agents.md",
              "claude.md",
              "claude.local.md",
              "gemini.md",
              "copilot-instructions.md",
            ].includes(part),
          ),
    )
  )
    return manual(paths === null ? "changed paths are unavailable" : "changes the risk rules");
  for (const id of ["security-review", "independent-review"]) {
    const review = run.steps.find((step) => step.id === id && step.kind === "review");
    const name = id === "security-review" ? "security review" : "independent review";
    if (review === undefined) return manual(`${name} is missing`);
    const severity = review.findingSeverities?.find((level) => level !== "P3");
    if (severity) return manual(`${name} has a ${severity} finding`);
    if (
      review.state !== "passed" ||
      review.attempt < 1 ||
      !review.evidencePath ||
      !Array.isArray(review.findingSeverities)
    )
      return manual(`${name} has no clean evidence for this head`);
  }
  if (
    run.steps.some(
      (step) =>
        step.state !== "passed" &&
        !(step.state === "skipped" && step.detail === "no changed path matches"),
    )
  )
    return manual("a Closeout check has not passed");
  const finding = listReviewFindings(db, {
    itemId: risk.itemId,
    head: risk.head,
    status: "open",
  }).find((entry) => entry.severity !== "P3");
  if (finding)
    return manual(
      `${finding.review === "security-review" ? "security review" : finding.review === "independent-review" ? "independent review" : finding.review} has a ${finding.severity} finding`,
    );
  return { eligible: true, detail: "Passes automatically: both reviews clean" };
}
