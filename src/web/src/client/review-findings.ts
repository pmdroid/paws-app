import type {
  StatusReview,
  StatusReviewFinding,
  StatusReviewRound,
  StatusVerdict,
} from "../contract";
import { checkKey, type CloseoutView } from "./closeout";
import { esc } from "./format";

/** The `CloseoutView.open` key of a review's earlier rounds. */
export function earlierRoundsKey(itemId: string, reviewId: string): string {
  return `rounds\n${checkKey(itemId, 1, reviewId)}`;
}

/**
 * Each review item's findings in the latest round, with its earlier rounds behind a disclosure.
 * Every finding text is model output, so all of it is escaped.
 */
export function reviewFindingsSection(verdict: StatusVerdict, view: CloseoutView): string {
  const reviews = (verdict.reviews ?? []).filter((review) => review.rounds.length > 0);
  if (reviews.length === 0) return "";
  const id = `review-findings-${esc(verdict.itemId)}`;
  return `<section class="closeout-section review-findings" aria-labelledby="${id}"><h2 id="${id}">Review findings</h2>${reviews.map((review) => reviewBlock(verdict.itemId, review, view)).join("")}</section>`;
}

function reviewBlock(itemId: string, review: StatusReview, view: CloseoutView): string {
  const latest = review.rounds.at(-1)!;
  const earlier = review.rounds.slice(0, -1);
  const open = view.open[earlierRoundsKey(itemId, review.id)] === true;
  const panel = `review-rounds-${esc(itemId)}-${esc(review.id)}`;
  const toggle = earlier.length
    ? `<div class="review-earlier"><button type="button" class="btn sm ghost" data-action="review-rounds-toggle" data-item="${esc(itemId)}" data-attempt="1" data-check="${esc(review.id)}" aria-expanded="${open}" aria-controls="${panel}">${open ? "Hide" : "Show"} earlier rounds (${earlier.length})</button>${
        open
          ? `<div id="${panel}" class="review-round-list">${earlier
              .map((round, index) => ({ round, number: index + 1 }))
              .reverse()
              .map(({ round, number }) => roundBlock(round, number, "h4"))
              .join("")}</div>`
          : ""
      }</div>`
    : "";
  return `<div class="review-block"><h3 class="mono">${esc(review.id)}</h3>${roundBlock(latest, review.rounds.length, null)}${toggle}</div>`;
}

function roundBlock(round: StatusReviewRound, number: number, heading: "h4" | null): string {
  const facts = [
    `Round ${number}`,
    `head ${round.headSha.slice(0, 7)}`,
    round.failOn ? `fails on ${round.failOn} or worse` : null,
  ].filter((fact) => fact !== null);
  const title = heading
    ? `<${heading} class="review-round-title">${esc(facts.join(" · "))}</${heading}>`
    : `<p class="muted">${esc(facts.join(" · "))}</p>`;
  const findings = [
    ...round.findings.map((finding) => findingItem(finding, number, round.failOn, false)),
    ...round.fixed.map((finding) => findingItem(finding, number, round.failOn, true)),
  ];
  const body = findings.length
    ? `<ul class="review-finding-list">${findings.join("")}</ul>`
    : `<p class="dim">No findings.</p>`;
  return `<div class="review-round">${title}${body}</div>`;
}

function findingItem(
  finding: StatusReviewFinding,
  round: number,
  failOn: StatusReviewRound["failOn"],
  fixed: boolean,
): string {
  const marks = [
    fixed ? `<span class="pill ok">Fixed since round ${round - 1}</span>` : "",
    finding.blocking
      ? `<span class="pill bad">Blocked${failOn ? `: meets failOn ${esc(failOn)}` : ""}</span>`
      : "",
    finding.preExisting && !fixed ? `<span class="pill">Pre-existing, does not block</span>` : "",
    finding.since === "open"
      ? `<span class="pill warn">Still open since round ${round - 1}</span>`
      : "",
    finding.since === "new" ? `<span class="pill">New in round ${round}</span>` : "",
  ].join("");
  const severity =
    finding.severity === "P0" || finding.severity === "P1"
      ? "bad"
      : finding.severity === "P2"
        ? "warn"
        : "";
  const state = fixed
    ? "fixed"
    : finding.blocking
      ? "blocking"
      : finding.preExisting
        ? "pre-existing"
        : "open";
  return `<li class="review-finding ${state}"><div class="row wrap"><span class="pill ${severity}">${esc(finding.severity)}</span><code class="review-location">${esc(finding.location)}</code>${marks}</div><p class="review-explanation">${esc(finding.explanation)}</p><p class="review-evidence"><span class="muted">Evidence</span> ${esc(finding.evidence)}</p></li>`;
}
