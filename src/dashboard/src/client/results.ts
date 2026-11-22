import type { IssueDetailResponse, StatusFollowUp, StatusItem } from "../contract";
import { clock24, esc, itemLabel, mergeQueueLine, safeHref, statePill } from "./format";
import { routeHref } from "./route";

const NOT_HANDED = "In Linear, not handed to Paws";

type PullState = "open" | "merged" | "closed";

export function resultsSection(snapshot: IssueDetailResponse, item: StatusItem): string {
  const pull = pullRequestCard(snapshot, item);
  const followUps = followUpsCard(snapshot.followUps);
  const below = mergeNotices(snapshot, item);
  if (!pull && !followUps && !below) return "";
  const cards =
    pull && followUps ? "grid grid-cols-1 gap-4 md:grid-cols-2" : "grid grid-cols-1 gap-4";
  return `<section class="issue-results flex min-w-0 flex-col gap-3" aria-labelledby="results-heading">
    <h2 id="results-heading" class="text-base font-semibold">Results</h2>
    ${pull || followUps ? `<div class="${cards}">${pull}${followUps}</div>` : ""}
    ${below}</section>`;
}

function pullState(snapshot: IssueDetailResponse, item: StatusItem): PullState {
  const outcome = snapshot.mergeHistory.findLast((candidate) => candidate.itemId === item.id);
  return item.state === "merged" || outcome?.outcome === "merged" ? "merged" : "open";
}

function pullPill(state: PullState): string {
  return statePill(state, state);
}

function pullRequestCard(snapshot: IssueDetailResponse, item: StatusItem): string {
  if (!item.pr) return "";
  const state = pullState(snapshot, item);
  const ci = state === "open" ? ciLine(snapshot, item) : "";
  return `<section class="results-card" aria-labelledby="results-pull-${esc(item.id)}" data-result-pull>
    <h3 id="results-pull-${esc(item.id)}" class="text-sm font-semibold text-muted-foreground">Pull request</h3>
    <p class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 [overflow-wrap:anywhere]"><a href="${esc(item.pr.url)}" target="_blank" rel="noopener noreferrer"><span class="lin-id">#${item.pr.number}</span> ${esc(item.title)}</a>${pullPill(state)}</p>
    ${ci ? `<p class="text-sm text-muted-foreground" data-result-ci>${esc(ci)}</p>` : ""}
    ${mergeLine(snapshot, item, state)}
  </section>`;
}

function ciLine(snapshot: IssueDetailResponse, item: StatusItem): string {
  const entry = snapshot.mergeQueue.find((candidate) => candidate.itemId === item.id);
  if (entry?.waitingFor === "ci") return "CI running";
  const round = snapshot.ciRounds.findLast((candidate) => candidate.itemId === item.id);
  return round ? `CI failed on ${round.head.slice(0, 7)}` : "";
}

function mergeLine(snapshot: IssueDetailResponse, item: StatusItem, state: PullState): string {
  const outcome = snapshot.mergeHistory.findLast((candidate) => candidate.itemId === item.id);
  const line =
    item.state === "merged"
      ? "Merged."
      : outcome?.outcome === "merged"
        ? `Merged at ${clock24(outcome.at)}.`
        : outcome?.outcome === "back_with_agent" && item.state !== "merge_queue"
          ? `Back with the agent after ${outcome.reason === "conflict" ? "a branch update conflicted" : "CI failed"}.`
          : item.state === "merge_queue"
            ? "Waiting to merge."
            : item.mergeQueue?.rechecking
              ? "Re-checking, keeps its place in the merge queue."
              : state === "open"
                ? "Not in the merge queue yet."
                : "";
  return line ? `<p class="text-sm" data-result-merge>${esc(line)}</p>` : "";
}

function mergeNotices(snapshot: IssueDetailResponse, item: StatusItem): string {
  const entry = snapshot.mergeQueue.find((candidate) => candidate.itemId === item.id);
  const steps = entry?.steps.length
    ? `<ol class="merge-steps" role="list">${entry.steps.map((step) => `<li>${statePill(step.state, step.name)}${step.detail ? `<span class="muted">${esc(step.detail)}</span>` : ""}</li>`).join("")}</ol>`
    : "";
  return mergeQueueNotice(item) + githubQueueNotice(item) + steps;
}

function mergeQueueNotice(item: StatusItem): string {
  const queue =
    item.state === "merge_queue" || (item.state === "verifying" && item.mergeQueue?.rechecking)
      ? item.mergeQueue
      : undefined;
  if (!queue) return "";
  const detail = queue.rechecking
    ? "Re-checking, keeps its place. Closeout runs again on this pull request; the ready ones behind it merge meanwhile, and it merges next once Closeout accepts it."
    : queue.position === 1 || queue.ahead === null
      ? "This pull request moves now: Paws updates its branch onto main if main moved, waits for CI on that commit, and merges it."
      : `${queue.ahead} merges first. When this one's turn comes, Paws updates its branch onto main if main moved and waits for CI.`;
  return `<section class="closeout-result queue-notice" aria-labelledby="merge-queue-${esc(item.id)}"><span class="result-icon" aria-hidden="true">${queue.position}</span><div><h3 id="merge-queue-${esc(item.id)}">${esc(mergeQueueLine(queue))}</h3><p>${esc(detail)}</p></div></section>`;
}

function githubQueueNotice(item: StatusItem): string {
  if (item.state !== "merge_queue" || !item.githubQueue) return "";
  const queue = item.githubQueue;
  return `<section class="closeout-result queue-notice" aria-labelledby="github-queue-${esc(item.id)}"><span class="result-icon" aria-hidden="true">${queue.position ?? "–"}</span><div><h3 id="github-queue-${esc(item.id)}">${esc(queue.line)}</h3><p>GitHub updates, batches and tests this pull request with the others in its merge queue. Paws does not rebase it or run Closeout again.</p></div></section>`;
}

function followUpsCard(followUps: readonly StatusFollowUp[]): string {
  if (!followUps.length) return "";
  return `<section class="results-card" aria-labelledby="results-follow-ups" data-result-follow-ups>
    <h3 id="results-follow-ups" class="text-sm font-semibold text-muted-foreground">Follow-up issues</h3>
    <ul class="flex flex-col gap-2" role="list">${followUps.map(followUpRow).join("")}</ul>
  </section>`;
}

function followUpRow(entry: StatusFollowUp): string {
  const id = `<span class="lin-id">${esc(entry.identifier)}</span>`;
  if (entry.title === undefined) return `<li class="min-w-0" data-follow-up>${id}</li>`;
  const linear = entry.url ? safeHref(entry.url) : null;
  const href = entry.path
    ? routeHref({ view: "issues", id: entry.identifier })
    : linear
      ? esc(linear)
      : null;
  const external = entry.path ? "" : ' target="_blank" rel="noopener noreferrer"';
  const label = `${id} ${esc(entry.title)}`;
  const link = href ? `<a href="${href}"${external}>${label}</a>` : label;
  const state = entry.state
    ? statePill(entry.state, itemLabel(entry.state))
    : `<span class="muted">${entry.started ? "Handed to Paws" : NOT_HANDED}</span>`;
  const pullUrl = entry.pull ? safeHref(entry.pull.url) : null;
  const pull =
    entry.pull && pullUrl
      ? `<a href="${esc(pullUrl)}" target="_blank" rel="noopener noreferrer" data-follow-up-pull><span class="lin-id">#${entry.pull.number}</span></a>${pullPill(entry.pull.state)}`
      : "";
  return `<li class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 [overflow-wrap:anywhere]" data-follow-up>${link}${state}${pull}</li>`;
}
