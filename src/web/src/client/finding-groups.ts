import {
  FINDING_GROUPS_API_PATH,
  type FindingGroupsResponse,
  type FindingGroupAction,
} from "../finding-groups";
import { esc } from "./format";

export function renderFindingGroups(
  data: FindingGroupsResponse | null,
  local: boolean,
  busy: boolean,
): string {
  if (!data) return '<div class="empty" role="status">Loading groups…</div>';
  const run = data.lastRun;
  const stats = !data.enabled
    ? "Daily grouping is off. An admin can turn it on in Settings → Findings."
    : run
      ? `Last run ${esc(new Date(run.startedAt).toISOString().slice(0, 16).replace("T", " "))} UTC · ${run.finishedAt === null ? "Running" : `${((run.finishedAt - run.startedAt) / 1000).toFixed(1)} s`} · ${run.tokens === null ? "Token use unavailable" : `${run.tokens} tokens`} · ${run.groupCount} group${run.groupCount === 1 ? "" : "s"}${run.skipReason ? ` · Skipped: ${esc(run.skipReason)}` : ""}${run.status === "failed" ? " · Failed. Check runner availability and try again tomorrow." : ""}`
      : "No grouping run yet. Scheduled daily at the configured UTC time.";
  const button =
    local && data.canRun
      ? `<button class="btn" type="button" data-group-action="run"${busy ? " disabled" : ""}>Run now</button>`
      : "";
  return `<div class="row wrap"><p class="muted" role="status">${stats}</p>${button}</div>
    <p>Groups suggest a shared fix. Filing an issue or adding a comment happens only when you choose an action.</p>
    ${
      data.groups.length
        ? `<ul class="issue-list finding-list" aria-label="Finding groups">${data.groups
            .map((group) => {
              const counts = ["P0", "P1", "P2", "P3"]
                .map((s) => ({
                  severity: s,
                  count: group.findings.filter((f) => f.severity === s).length,
                }))
                .filter((c) => c.count);
              const actions =
                local && group.status === "open"
                  ? `<div class="row wrap">
        ${!group.action || group.action === "file" ? `<button class="btn primary" type="button" data-group-action="file" data-group-id="${esc(group.id)}"${busy ? " disabled" : ""}>File as one issue</button>` : ""}
        ${group.suggestedIssue && (!group.action || group.action === "add") ? `<button class="btn" type="button" data-group-action="add" data-group-id="${esc(group.id)}"${busy ? " disabled" : ""}>Add to ${esc(group.suggestedIssue)}</button>` : ""}
        ${!group.action || group.action === "dismiss" ? `<details class="finding-dismiss"><summary class="btn">Dismiss group</summary><form class="col" data-group-dismiss="${esc(group.id)}"><label class="field"><span>Why dismiss this group?</span><input name="reason" required maxlength="500" /></label><button class="btn" type="submit"${busy ? " disabled" : ""}>Dismiss group</button></form></details>` : ""}
      </div>`
                  : `<p class="muted">${esc(group.status)}${group.filedIssue ? ` as ${esc(group.filedIssue)}` : ""}${group.statusReason ? `: ${esc(group.statusReason)}` : ""}</p>`;
              return `<li class="finding space-y-3"><h2>${esc(group.title)}</h2><p class="finding-text max-w-prose">${esc(group.summary)}</p>
        <p><strong>Scope:</strong> ${esc(group.scope)}</p><div class="row wrap"><span>${group.findings.length} finding${group.findings.length === 1 ? "" : "s"}</span>${counts.map((c) => `<span class="tag ${c.severity === "P0" || c.severity === "P1" ? "err" : c.severity === "P2" ? "warn" : ""}">${c.severity}: ${c.count}</span>`).join("")}<span class="muted">${esc(group.repository)}</span></div>
        <details><summary>Show findings</summary><ul>${group.findings.map((f) => `<li><a href="?status=all#finding-${f.id}" data-group-finding="${f.id}"><code>${esc(f.path)}${f.lines ? `:${esc(f.lines)}` : ""}</code></a> <span class="tag">${esc(f.severity)}</span><p class="finding-text">${esc(f.text)}</p></li>`).join("")}</ul></details>${actions}</li>`;
            })
            .join("")}</ul>`
        : '<div class="empty" role="status">No groups yet. New or changed findings will be grouped on the next daily run.</div>'
    }`;
}
export async function findingGroupsRequest(
  engine: string,
  action?: FindingGroupAction,
  csrf?: string,
): Promise<FindingGroupsResponse | { ok?: boolean; queued?: boolean }> {
  const response = await fetch(
    new URL(FINDING_GROUPS_API_PATH, engine),
    action
      ? {
          method: "POST",
          cache: "no-store",
          headers: { "content-type": "application/json", "x-paws-csrf": csrf ?? "" },
          body: JSON.stringify(action),
        }
      : { cache: "no-store" },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`);
  return data;
}
