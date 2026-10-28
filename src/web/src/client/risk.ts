import type { RiskList, StatusItemRisk } from "../contract";
import { esc } from "./format";

/** Where each list is edited, as the card names it. */
const LISTS: Record<RiskList, string> = {
  settings: "Settings › Merging",
  file: ".paws/high-risk-paths",
};

/** Closeout's detail for a check whose `paths` matched no changed path. */
const NO_PATH_MATCHES = "no changed path matches";

/**
 * The Risk card on the issue page: the tier of the latest classified commit, each high-risk path
 * it changed with the list that matched it, and whether the security review ran or was skipped.
 */
export function riskCard(risk: StatusItemRisk | null | undefined): string {
  if (!risk) return "";
  const tier =
    risk.tier === "high"
      ? '<span class="tag failed">High</span>'
      : risk.tier === "normal"
        ? '<span class="tag passed">Normal</span>'
        : '<span class="tag">Not classified</span>';
  const commit = risk.head ? ` <span class="mono">${esc(risk.head.slice(0, 7))}</span>` : "";
  const summary =
    risk.tier === null
      ? "Paws classifies the risk when Closeout accepts a commit."
      : risk.tier === "high"
        ? `Commit${commit} changes ${risk.paths.length} high-risk ${risk.paths.length === 1 ? "path" : "paths"}.`
        : `Commit${commit} changes no high-risk path.`;
  const paths = risk.paths.length
    ? `<ul class="risk-paths">${risk.paths
        .map(
          (entry) =>
            `<li><code>${esc(entry.path)}</code><span class="muted">${esc(
              entry.lists.length
                ? `Matched by ${entry.lists.map((list) => LISTS[list]).join(" and ")}`
                : "Matched list not recorded",
            )}</span></li>`,
        )
        .join("")}</ul>`
    : "";
  return `<section id="risk-tier" class="card risk-card" aria-labelledby="risk-heading"><div class="row wrap"><h2 id="risk-heading">Risk</h2>${tier}</div><p>${summary}</p>${paths}${risk.automaticApproval ? '<p class="risk-review">Approved automatically: both reviews clean</p>' : ""}<p class="risk-review">${securityReviewLine(risk)}</p><p class="muted">A path is high-risk when a glob in ${LISTS.settings} or in the repository's ${LISTS.file} matches it.</p></section>`;
}

/** "Security review skipped: no high-risk path", or what the review did. */
export function securityReviewLine(risk: StatusItemRisk): string {
  const review = risk.securityReview;
  if (review === null) return "No security review in this repository's Closeout policy.";
  const commit =
    review.head && risk.head && review.head !== risk.head
      ? ` for commit <span class="mono">${esc(review.head.slice(0, 7))}</span>`
      : "";
  const detail = review.detail ? `: ${esc(review.detail.replace(/\.$/, ""))}` : "";
  switch (review.state) {
    case "skipped":
      return `Security review skipped${commit}: ${
        review.detail === null || review.detail === NO_PATH_MATCHES
          ? "no high-risk path"
          : esc(review.detail.replace(/\.$/, ""))
      }.`;
    case "passed":
      return `Security review ran${commit}: passed.`;
    case "failed":
      return `Security review ran${commit}: failed${detail}.`;
    case "running":
      return `Security review running${commit}.`;
    case "pending":
      return `Security review waiting to run${commit}.`;
    default:
      return `Security review ${review.state}${commit}${detail}.`;
  }
}
