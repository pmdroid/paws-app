import type {
  StatusItem,
  StatusSnapshot,
  StatusVisualReview,
  StatusVisualReviewCarry,
} from "../contract";
import { ago, esc, linkButtons } from "./format";
import { evidenceFileUrl, evidencePageHref, evidenceVersions, thumbnailMedia } from "./evidence";

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

/** Every screen carried an approval over, so nobody was asked. */
function carriedInFull(review: StatusVisualReview): boolean {
  const carried = review.carried ?? [];
  return (
    carried.length > 0 &&
    review.evidenceIds.every((id) => carried.some((entry) => entry.evidenceId === id))
  );
}

/** The latest original approval the review's carried screens came from. */
function carriedFrom(review: StatusVisualReview) {
  return (review.carried ?? []).reduce<StatusVisualReviewCarry | null>(
    (latest, entry) => (latest === null || entry.approvedAt > latest.approvedAt ? entry : latest),
    null,
  );
}

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
    ? `<section class="closeout-result blocked"><div class="min-w-0"><h3>Waiting for ${esc(item.owner ?? "the person who delegated this issue")} or the project lead · round ${waiting.round}</h3><p>Accept the screenshots in Linear, or reply with the changes you want. The task resumes with the answer.</p>${links?.length ? `<div class="row">${linkButtons(links)}</div>` : ""}<div id="review-draw" data-question="${esc(waiting.questionId)}" hidden></div></div></section>`
    : last.state === "accepted" && carriedInFull(last)
      ? carriedSummary(snapshot, reviews, last)
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

function carriedSummary(
  snapshot: StatusSnapshot,
  reviews: readonly StatusVisualReview[],
  review: StatusVisualReview,
): string {
  const from = carriedFrom(review)!;
  const source = reviews.find((entry) => entry.questionId === from.approvalId);
  const similar = review.carried!.some((entry) => entry.match === "similar");
  return `<section class="closeout-result accepted"><div class="min-w-0"><h3>Carried over from ${esc(from.approvedBy)}'s approval${source ? ` in round ${source.round}` : ""} · ${esc(ago(from.approvedAt, snapshot.generatedAt))}</h3><p>The new screenshots ${similar ? "look the same as" : "are identical to"} the ones ${esc(from.approvedBy)} accepted, so Paws didn't ask again. The pull request names the original approval.</p></div></section>`;
}

function roundEntry(
  snapshot: StatusSnapshot,
  review: StatusVisualReview,
  next: StatusVisualReview | undefined,
  engineUrl: string | null,
): string {
  const full = carriedInFull(review);
  const [tone, label] = STATE_TAG[review.state];
  const from = carriedFrom(review);
  const who =
    full && from
      ? `<span class="muted">${esc(`Approved by ${from.approvedBy}`)} · ${esc(ago(from.approvedAt, snapshot.generatedAt))}</span>`
      : review.answeredBy
        ? `<span class="muted">${esc(review.state === "changes_requested" ? `${review.answeredBy} requested changes` : review.answeredBy)}${review.answeredAt ? ` · ${esc(ago(review.answeredAt, snapshot.generatedAt))}` : ""}</span>`
        : `<span class="muted">Sent ${esc(ago(review.askedAt, snapshot.generatedAt))}</span>`;
  const feedback = review.feedback ? `<div class="ctx">${esc(review.feedback)}</div>` : "";
  const addressed =
    review.state === "changes_requested"
      ? `<p class="muted">${next?.commit ? `Addressed in <span class="mono">${esc(next.commit.slice(0, 7))}</span>, sent as round ${next.round}.` : "The agent is addressing these changes."}</p>`
      : "";
  const files = evidenceVersions(
    review.evidenceIds.flatMap((id) => snapshot.evidence?.find((entry) => entry.id === id) ?? []),
  )
    .map(({ latest: entry }) => {
      const mark = review.marks?.find((row) => row.evidenceId === entry.id);
      const marked = mark
        ? `<li><a class="evidence-thumb" href="${esc(evidenceFileUrl(mark.id, engineUrl))}" target="_blank" rel="noopener" aria-label="${esc(`Marked ${entry.displayName}`)}"><img src="${esc(evidenceFileUrl(mark.id, engineUrl))}" alt="${esc(`Marked ${entry.displayName}`)}" loading="lazy" decoding="async" class="block h-full w-full object-cover" /></a><span class="muted">${esc(entry.displayName)} · Marked by the reviewer</span></li>`
        : "";
      const carry = review.carried?.find((row) => row.evidenceId === entry.id);
      const state = carry
        ? `${carry.match === "identical" ? "Unchanged" : "Looks the same"} since ${carry.approvedBy}'s approval`
        : EVIDENCE_STATE[review.state];
      return `<li><a class="evidence-thumb" href="${esc(evidencePageHref(entry.id))}" aria-label="${esc(entry.displayName)}">${thumbnailMedia(entry, engineUrl)}</a><span class="muted">${esc(entry.displayName)} · ${esc(state)}</span></li>${marked}`;
    })
    .join("");
  return `<li class="visual-review-round"><div class="row"><b>${full ? "Carried over" : `Round ${review.round}`}</b><span class="tag">${esc(review.checkId)}</span>${full ? "" : `<span class="tag ${tone}">${esc(label)}</span>`}${review.commit ? `<span class="mono muted">${esc(review.commit.slice(0, 7))}</span>` : ""}${who}</div>${feedback}${addressed}${files ? `<ul class="evidence-more">${files}</ul>` : ""}</li>`;
}
