import type { IssueDetailResponse, StatusFollowUp } from "../contract";
import { esc, itemLabel, safeHref, statePill } from "./format";
import { routeHref } from "./route";

const NOT_HANDED = "In Linear, not handed to Paws";

export function filedFromLine(snapshot: Pick<IssueDetailResponse, "filedFrom">): string {
  const origin = snapshot.filedFrom;
  if (!origin) return "";
  const id = `<span class="lin-id">${esc(origin.identifier)}</span>`;
  const text =
    origin.title === undefined
      ? `Filed from ${id}`
      : `Filed from <a href="${routeHref({ view: "issues", id: origin.identifier })}">${id}: ${esc(origin.title)}</a>`;
  return `<p class="text-sm text-muted-foreground [overflow-wrap:anywhere]" data-filed-from>${text}</p>`;
}

export function followUpsSection(snapshot: Pick<IssueDetailResponse, "followUps">): string {
  if (!snapshot.followUps.length) return "";
  return `<section class="follow-ups flex min-w-0 flex-col gap-2" aria-labelledby="follow-ups-heading">
    <h2 id="follow-ups-heading" class="text-base font-semibold">Follow-ups</h2>
    <ul class="flex flex-col gap-2" role="list">${snapshot.followUps.map(followUpRow).join("")}</ul>
  </section>`;
}

function followUpRow(entry: StatusFollowUp): string {
  const id = `<span class="lin-id">${esc(entry.identifier)}</span>`;
  if (entry.title === undefined) return `<li class="min-w-0" data-follow-up>${id}</li>`;
  const linear = entry.url ? safeHref(entry.url) : null;
  const link = entry.path
    ? `<a href="${routeHref({ view: "issues", id: entry.identifier })}">${id}</a>`
    : linear
      ? `<a href="${esc(linear)}" target="_blank" rel="noopener noreferrer">${id}</a>`
      : id;
  const state = entry.state
    ? statePill(entry.state, itemLabel(entry.state))
    : `<span class="muted">${entry.started ? "Handed to Paws" : NOT_HANDED}</span>`;
  return `<li class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 [overflow-wrap:anywhere]" data-follow-up>${link}<span class="min-w-0">${esc(entry.title)}</span>${state}</li>`;
}
