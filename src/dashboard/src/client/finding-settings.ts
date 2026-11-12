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
): string {
  if (!groups) return "";
  const editable = local && groups.canChange && !busy;
  const run = groups.lastRun
    ? `Last run ${esc(new Date(groups.lastRun.startedAt).toISOString().slice(0, 16).replace("T", " "))} UTC`
    : "Not run yet";
  const note = groups.canChange
    ? ""
    : '<span class="muted">Only workspace admins can change this.</span>';
  return `<div class="row wrap" data-finding-grouping=""><label class="settings-inherit"><input type="checkbox" role="switch" name="finding-grouping" ${groups.enabled ? "checked" : ""} ${editable ? "" : "disabled"}>Group similar findings into suggested fixes once a day</label><span class="muted">${run}</span>${note}</div>`;
}

export async function findingSettingsRequest(
  engine: string,
  body?: { grouping: boolean },
): Promise<FindingSettings> {
  const response = await fetch(new URL(PATH, engine), {
    method: body ? "POST" : "GET",
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
