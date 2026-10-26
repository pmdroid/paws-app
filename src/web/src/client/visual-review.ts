import type {
  StatusItem,
  StatusQuestion,
  StatusSnapshot,
  StatusVisualReview,
  StatusVisualReviewCarry,
} from "../contract";
import { ago, esc, linkButtons } from "./format";
import { evidenceFileUrl, evidencePageHref, evidenceVersions, thumbnailMedia } from "./evidence";
import { linkAskDraft, linkAskMessage, linkAskPending } from "./link-ask";
import { drawnMarkCount, drawnStrokes, strokesOverlay } from "./review-marks";

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

/** The open screenshots link ask of the item's latest review, decided on this page. */
export function visualReviewAsk(
  snapshot: StatusSnapshot,
  item: StatusItem,
): { question: StatusQuestion; review: StatusVisualReview } | undefined {
  const review = item.visualReviews?.at(-1);
  const question = snapshot.questions.find(
    (entry) => entry.id === review?.questionId && entry.linkAsk?.kind === "screenshots",
  );
  return question && review ? { question, review } : undefined;
}

/**
 * The item page's Visual review card. While the screenshots link ask is
 * open it shows the changed screens large enough to judge, the marks drawn on
 * them, the earlier rounds, and Approve, Request changes and Stop. `stopItemId`
 * is the item the execution controls stop.
 */
export function visualReviewSection(
  snapshot: StatusSnapshot,
  item: StatusItem,
  engineUrl: string | null,
  stopItemId?: string,
): string {
  const reviews = item.visualReviews ?? [];
  const last = reviews.at(-1);
  if (!last) return "";
  const ask = visualReviewAsk(snapshot, item);
  if (ask) return askCard(snapshot, item, ask, engineUrl, stopItemId);
  const waiting = waitingVisualReview(item);
  const links = snapshot.questions.find((question) => question.id === waiting?.questionId)?.links;
  const summary = waiting
    ? `<section class="closeout-result blocked"><div class="min-w-0"><h3>Waiting for ${esc(item.owner ?? "the person who delegated this issue")} or the project lead · round ${waiting.round}</h3><p>Reply in Linear with the changes you want. A reply in Linear never approves the screens.</p>${links?.length ? `<div class="row">${linkButtons(links)}</div>` : ""}<div id="review-draw" data-question="${esc(waiting.questionId)}" hidden></div></div></section>`
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

function marksLabel(count: number): string {
  return count === 1 ? "1 mark" : `${count} marks`;
}

function askCard(
  snapshot: StatusSnapshot,
  item: StatusItem,
  ask: { question: StatusQuestion; review: StatusVisualReview },
  engineUrl: string | null,
  stopItemId: string | undefined,
): string {
  const { question, review } = ask;
  const linkAsk = question.linkAsk!;
  const id = question.id;
  const commit = linkAsk.head.slice(0, 7);
  const carried = new Set((review.carried ?? []).map((entry) => entry.evidenceId));
  const files = evidenceVersions(
    review.evidenceIds.flatMap((evidenceId) =>
      carried.has(evidenceId)
        ? []
        : (snapshot.evidence?.find((entry) => entry.id === evidenceId) ?? []),
    ),
  ).map(({ latest }) => latest);
  const shots = files
    .map((entry, index) => {
      const strokes = drawnStrokes(id, entry.id);
      const media =
        entry.kind === "image"
          ? `<span class="visual-review-media"><img src="${esc(evidenceFileUrl(entry.id, engineUrl))}" alt="${esc(entry.displayName)}" loading="lazy" decoding="async" />${strokesOverlay(strokes)}</span>`
          : thumbnailMedia(entry, engineUrl);
      const draw =
        entry.kind === "image"
          ? ` data-review-draw="${esc(id)}" data-review-shot="${index}" data-evidence-id="${esc(entry.id)}" data-name="${esc(entry.displayName)}" data-src="${esc(evidenceFileUrl(entry.id, engineUrl))}"`
          : "";
      return `<li><a class="visual-review-frame" href="${esc(evidencePageHref(entry.id))}"${draw} aria-label="${esc(`${entry.displayName}. Open, or draw on it to show what to change`)}">${media}</a><span>${esc(entry.displayName)}${strokes.length ? ` · <b>${marksLabel(strokes.length)}</b>` : ""}</span></li>`;
    })
    .join("");
  const carriedNames = (review.carried ?? []).flatMap(
    (entry) => snapshot.evidence?.find((row) => row.id === entry.evidenceId)?.displayName ?? [],
  );
  const reviews = item.visualReviews ?? [];
  const earlier = reviews
    .filter((entry) => entry.questionId !== review.questionId && entry.checkId === review.checkId)
    .map((entry, index, list) => {
      const next = list.slice(index + 1).find((later) => later.checkId === entry.checkId) ?? review;
      return `<li>${earlierRound(entry, next)}</li>`;
    })
    .reverse()
    .join("");
  const count = drawnMarkCount(id);
  const busy = linkAskPending(id) ? ' disabled=""' : "";
  const owner = item.owner
    ? `${item.owner}, who delegated ${item.id},`
    : "The person who delegated this issue";
  const stop = stopItemId
    ? `<details class="visual-review-stop"><summary class="btn">Stop</summary><p>Stop this item and keep its branch?</p><button class="btn sm" type="button" data-visual-review-stop="${esc(stopItemId)}"${busy}>Confirm stop</button></details>`
    : "";
  return `<section id="visual-review" class="card visual-review visual-review-ask" aria-labelledby="visual-review-heading"><div class="row wrap"><span class="tag warn">Needs you</span><h2 id="visual-review-heading">Visual review</h2><span class="tag">${esc(review.checkId)} · round ${review.round}</span><span class="mono muted">${esc(commit)}</span></div><p>Look at the ${files.length === 1 ? "changed screen" : `${files.length} changed screens`} of <span class="mono">${esc(commit)}</span>. Draw on a screenshot to show what to change.</p>${shots ? `<ul class="visual-review-shots" role="list">${shots}</ul>` : ""}${carriedNames.length ? `<p class="muted">Unchanged since an earlier approval, so not asked again: ${esc(carriedNames.join(", "))}.</p>` : ""}${earlier ? `<ul class="visual-review-earlier" role="list">${earlier}</ul>` : ""}<p class="muted">${esc(owner)} and the project lead can answer here. A reply in Linear never approves; it requests changes.</p><form class="link-ask-form" data-visual-review-ask="${esc(id)}"><label class="field"><span>What to change</span><textarea name="note" rows="3" maxlength="10000">${esc(linkAskDraft(id))}</textarea></label><div class="row wrap"><button class="btn primary" type="submit" name="decision" value="approve"${busy}>Approve ${esc(commit)}</button><button class="btn" type="submit" name="decision" value="changes"${busy}>Request changes${count ? ` (${marksLabel(count)})` : ""}</button>${stop}</div><p class="muted" role="status">${esc(linkAskMessage(id))}</p></form><p class="muted">The approval covers commit <span class="mono">${esc(commit)}</span> and these screenshots. A rebase that keeps the same patch keeps it; any other new commit asks again.</p></section>`;
}

function earlierRound(review: StatusVisualReview, next: StatusVisualReview): string {
  const commit = review.commit
    ? ` · <span class="mono">${esc(review.commit.slice(0, 7))}</span>`
    : "";
  const marks = review.marks?.length ?? 0;
  const what =
    review.state === "changes_requested"
      ? `Changes requested${review.answeredBy ? ` by ${esc(review.answeredBy)}` : ""}${marks ? ` · ${marksLabel(marks)}` : ""}${next.commit ? `, addressed in <span class="mono">${esc(next.commit.slice(0, 7))}</span>` : ""}`
      : review.state === "accepted"
        ? `Accepted${review.answeredBy ? ` by ${esc(review.answeredBy)}` : ""}`
        : review.state === "stale"
          ? "Superseded by new commits"
          : "Not answered; a new commit asked again";
  return `<b>Round ${review.round}</b>${commit} · ${what}${review.feedback ? `<div class="ctx">${esc(review.feedback)}</div>` : ""}`;
}
