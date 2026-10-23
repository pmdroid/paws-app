import type { StatusItem, StatusSnapshot, StatusVisualReview } from "../contract";
import { ago, esc, linkButtons } from "./format";
import { evidencePageHref, thumbnailMedia } from "./evidence";

const STATE_TAG: Record<StatusVisualReview["state"], [string, string]> = {
  waiting: ["warn", "Waiting"],
  accepted: ["accepted", "Accepted"],
  changes_requested: ["bad", "Changes requested"],
  stale: ["bad", "Superseded by new commits"],
};

const EVIDENCE_STATE: Record<StatusVisualReview["state"], string> = {
  waiting: "Sent to Linear",
  accepted: "Accepted",
  changes_requested: "Superseded",
  stale: "Superseded",
};

export function waitingVisualReview(item: StatusItem | undefined): StatusVisualReview | undefined {
  const review = item?.visualReviews?.at(-1);
  return review?.state === "waiting" && item?.state === "awaiting_input" ? review : undefined;
}

export function visualReviewSection(
  snapshot: StatusSnapshot,
  item: StatusItem,
  engineUrl: string | null,
): string {
  const reviews = item.visualReviews ?? [];
  const last = reviews.at(-1);
  if (!last) return "";
  const waiting = waitingVisualReview(item);
  const links = snapshot.questions.find((question) => question.id === waiting?.questionId)?.links;
  const summary = waiting
    ? `<section class="closeout-result blocked"><div class="min-w-0"><h3>Waiting for ${esc(item.owner ?? "the person who delegated this issue")} or the project lead · round ${waiting.round}</h3><p>Accept the screenshots in Linear, or reply with the changes you want. The task resumes with the answer.</p>${links?.length ? `<div class="row">${linkButtons(links)}</div>` : ""}</div></section>`
    : last.state === "accepted"
      ? `<section class="closeout-result accepted"><div class="min-w-0"><h3>Accepted by ${esc(last.answeredBy ?? "a reviewer")}${last.answeredAt ? ` · ${esc(ago(last.answeredAt, snapshot.generatedAt))}` : ""}</h3><p>The pull request records the approved screenshots.</p></div></section>`
      : "";
  const rounds = reviews
    .map((review, index) => {
      const next = reviews.slice(index + 1).find((entry) => entry.checkId === review.checkId);
      return roundEntry(snapshot, review, next, engineUrl);
    })
    .reverse()
    .join("");
  return `<section class="card visual-review" aria-labelledby="visual-review-heading"><h2 id="visual-review-heading">Visual review</h2>${summary}<ol class="visual-review-rounds">${rounds}</ol></section>`;
}

function roundEntry(
  snapshot: StatusSnapshot,
  review: StatusVisualReview,
  next: StatusVisualReview | undefined,
  engineUrl: string | null,
): string {
  const [tone, label] = STATE_TAG[review.state];
  const who = review.answeredBy
    ? `<span class="muted">${esc(review.state === "changes_requested" ? `${review.answeredBy} requested changes` : review.answeredBy)}${review.answeredAt ? ` · ${esc(ago(review.answeredAt, snapshot.generatedAt))}` : ""}</span>`
    : `<span class="muted">Sent ${esc(ago(review.askedAt, snapshot.generatedAt))}</span>`;
  const feedback = review.feedback ? `<div class="ctx">${esc(review.feedback)}</div>` : "";
  const addressed =
    review.state === "changes_requested"
      ? `<p class="muted">${next?.commit ? `Addressed in <span class="mono">${esc(next.commit.slice(0, 7))}</span>, sent as round ${next.round}.` : "The agent is addressing these changes."}</p>`
      : "";
  const files = review.evidenceIds
    .flatMap((id) => snapshot.evidence?.find((entry) => entry.id === id) ?? [])
    .map(
      (entry) =>
        `<li><a class="evidence-thumb" href="${esc(evidencePageHref(entry.id))}" aria-label="${esc(entry.displayName)}">${thumbnailMedia(entry, engineUrl)}</a><span class="muted">${esc(entry.displayName)} · ${esc(EVIDENCE_STATE[review.state])}</span></li>`,
    )
    .join("");
  return `<li class="visual-review-round"><div class="row"><b>Round ${review.round}</b><span class="tag">${esc(review.checkId)}</span><span class="tag ${tone}">${esc(label)}</span>${review.commit ? `<span class="mono muted">${esc(review.commit.slice(0, 7))}</span>` : ""}${who}</div>${feedback}${addressed}${files ? `<ul class="evidence-more">${files}</ul>` : ""}</li>`;
}
