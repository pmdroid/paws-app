import { journalCaught } from "../journal";
import { esc } from "./format";
import { readCsrfToken } from "./csrf";

import type { FindingGroupsResponse } from "../finding-groups";

export type FindingSettings = { grouping: boolean; groupingTime: string };

const PATH = "/api/settings/findings";

export function renderGroupingRow(
  groups: FindingGroupsResponse | null | undefined,
  local: boolean,
  busy: boolean,
  time?: string,
): string {
  if (!groups) return "";
  const editable = local && groups.canChange && !busy;
  const run = groups.lastRun
    ? `Last run ${esc(new Date(groups.lastRun.startedAt).toISOString().slice(0, 16).replace("T", " "))} UTC`
    : "Not run yet";
  const note = groups.canChange
    ? ""
    : '<span class="muted">Only workspace admins can change this.</span>';
  return `<div class="row wrap" data-finding-grouping=""><label class="settings-inherit"><input type="checkbox" role="switch" name="finding-grouping" ${groups.enabled ? "checked" : ""} ${editable ? "" : "disabled"}><span class="min-w-0 flex-1">Group similar findings into suggested fixes once a day</span></label><span class="muted">${run}</span>${note}</div>${time === undefined ? '<p class="muted">Grouping time is unavailable.</p>' : local && groups.canChange ? `<form class="row wrap" data-grouping-time><label for="grouping-time">Daily grouping time (UTC)</label><input id="grouping-time" name="groupingTime" type="time" required value="${esc(time)}"${busy ? " disabled" : ""}><button class="btn" type="submit"${busy ? " disabled" : ""}>Save time</button></form>` : `<p>Daily grouping time: ${esc(time)} UTC</p>`}`;
}

export async function findingSettingsRequest(
  engine: string,
  body?: { grouping: boolean } | { groupingTime: string },
): Promise<FindingSettings> {
  const response = await fetch(new URL(PATH, engine), {
    method: body ? ("groupingTime" in body ? "PUT" : "POST") : "GET",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(body
        ? { "Content-Type": "application/json", "x-paws-csrf": readCsrfToken(document) }
        : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch((error) => {
    journalCaught(error, "finding-settings.findingSettingsRequest.json", null);
    return {};
  });
  if (!response.ok)
    throw new Error(
      typeof data.error === "string" ? data.error : `Request failed (${response.status}).`,
      { cause: response.status },
    );
  return data as FindingSettings;
}
