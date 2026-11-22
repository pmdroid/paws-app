import type { IssueDetailResponse } from "../contract";
import { esc } from "./format";
import { routeHref } from "./route";

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
