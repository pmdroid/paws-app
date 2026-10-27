import type {
  MergeWaitReason,
  StatusItem,
  StatusMergeEntry,
  StatusMergeOutcome,
  StatusMergeSettings,
  StatusSnapshot,
} from "../contract";
import { ago, esc, safeHref, statePill } from "./format";
import { routeHref } from "./route";

/** Every task Closeout accepted that waits to merge, one section per repository. */
export function renderMergeQueue(snapshot: StatusSnapshot): string {
  const repositories = groups(snapshot);
  const intro = `<p>Accepted pull requests merge one at a time per repository, in the order Closeout accepted them.</p>`;
  if (!repositories.length)
    return `${intro}<div class="empty" role="status">Nothing is waiting to merge.</div>`;
  return `${intro}${repositories.map((group) => section(snapshot, group)).join("")}`;
}

/** The navigation badge: how many tasks wait to merge. */
export function mergeQueueCount(snapshot: StatusSnapshot | null): number {
  return snapshot?.mergeQueue.length ?? 0;
}

type Group = {
  /** Null gathers the tasks Paws knows no repository for. */
  repository: string | null;
  settings: StatusMergeSettings;
  waiting: StatusMergeEntry[];
  history: StatusMergeOutcome[];
};

function groups(snapshot: StatusSnapshot): Group[] {
  const byRepository = new Map<string | null, Group>();
  const group = (repository: string | null, settings: StatusMergeSettings): Group => {
    let found = byRepository.get(repository);
    if (!found) {
      found = { repository, settings, waiting: [], history: [] };
      byRepository.set(repository, found);
    }
    return found;
  };
  for (const entry of snapshot.mergeQueue)
    group(entry.repository, entry.settings).waiting.push(entry);
  for (const entry of snapshot.mergeHistory ?? [])
    group(entry.repository, entry.settings).history.push(entry);
  for (const found of byRepository.values()) {
    // An issue rule changes one task, not the repository. The section shows the settings most
    // tasks there use; a task its rule sets apart says so in its row.
    const plain = [...found.waiting, ...found.history].find(
      (entry) => entry.settings.rule === null,
    );
    if (plain) found.settings = plain.settings;
    found.waiting.sort(
      (left, right) =>
        (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER) ||
        left.acceptedAt.localeCompare(right.acceptedAt),
    );
    found.history.sort((left, right) => right.at.localeCompare(left.at));
  }
  return [...byRepository.values()].sort((left, right) =>
    left.repository === null
      ? 1
      : right.repository === null
        ? -1
        : left.repository.localeCompare(right.repository),
  );
}

function section(snapshot: StatusSnapshot, group: Group): string {
  const { repository } = group;
  const queued = group.settings.order === "queue";
  const id =
    repository === null
      ? "merge-repo-not-known"
      : `merge-repo-${repository.replace(/[^A-Za-z0-9-]/g, "-")}`;
  const table = group.waiting.length
    ? `<table class="run-table merge-table"><thead><tr>${queued ? `<th class="run-cell">#</th>` : ""}<th class="run-cell">Issue</th><th class="run-cell hide-phone">Project</th><th class="run-cell hide-phone">Delegated by</th><th class="run-cell">PR</th><th class="run-cell hide-phone">Waiting</th><th class="run-cell">Step</th><th class="run-cell hide-phone">Detail</th></tr></thead><tbody>${group.waiting.map((entry) => row(snapshot, group, entry)).join("")}</tbody></table>`
    : `<p class="muted">No pull requests waiting.</p>`;
  const done = group.history.length
    ? `<h3>Done and stopped</h3><ul class="overview-work" role="list">${group.history.map((entry) => outcome(snapshot, entry)).join("")}</ul>`
    : "";
  return `<section class="col merge-repo" aria-labelledby="${esc(id)}"><div class="between"><h2 id="${esc(id)}">${repository === null ? "Repository not known" : esc(repository)}</h2>${repository === null ? "" : `<div class="row">${settingsTags(group.settings)}</div>`}</div>${repository === null ? `<p class="muted">Paws has no repository for these tasks.</p>` : queued ? "" : `<p class="muted">No queue here: each pull request merges when green.</p>`}${table}${done}</section>`;
}

function settingsTags(settings: StatusMergeSettings): string {
  const order =
    settings.order === "queue"
      ? "Merge queue on"
      : settings.order === "github-queue"
        ? "GitHub merge queue"
        : "Merge each when green";
  return `<span class="tag">${esc(order)}</span><span class="tag">${esc(`Re-check: ${recheck(settings)}`)}</span>`;
}

function recheck(settings: StatusMergeSettings): string {
  if (settings.mainMoved === "closeout") return "Closeout again";
  if (settings.mainMoved === "overlap") return "CI when files overlap";
  return "CI only";
}

const STEP: Record<MergeWaitReason, { label: string; state: string }> = {
  ahead: { label: "Queued", state: "queued" },
  ci: { label: "Waiting for CI", state: "running" },
  review: { label: "Waiting for review", state: "warn" },
  branch_update: { label: "Updating branch", state: "running" },
  closeout: { label: "Closeout re-check", state: "verifying" },
};

function row(snapshot: StatusSnapshot, group: Group, entry: StatusMergeEntry): string {
  const item = snapshot.items.find((candidate) => candidate.id === entry.itemId);
  const queued = group.settings.order === "queue";
  const step = STEP[entry.waitingFor];
  const position = queued
    ? `<td class="run-cell">${entry.position === null ? `<span class="muted" aria-label="No place yet">–</span>` : String(entry.position)}</td>`
    : "";
  return `<tr data-merge-item="${esc(entry.itemId)}">${position}<td class="run-cell">${issueLink(item, entry.itemId)}</td><td class="run-cell hide-phone">${esc(item?.project?.name ?? "No project")}</td><td class="run-cell hide-phone">${esc(item?.owner ?? "")}</td><td class="run-cell">${pullLink(item)}</td><td class="run-cell hide-phone"><span class="muted" title="Closeout accepted ${esc(entry.acceptedAt)}">${esc(waited(entry.acceptedAt, snapshot.generatedAt))}</span></td><td class="run-cell">${statePill(step.state, step.label)}</td><td class="run-cell hide-phone">${esc(detail(group, entry, item))}</td></tr>`;
}

function detail(group: Group, entry: StatusMergeEntry, item: StatusItem | undefined): string {
  const lines: string[] = [];
  if (entry.detail) lines.push(entry.detail.replace(/\.$/, ""));
  else if (entry.waitingFor === "review")
    lines.push(
      `Waiting for an approving review${item?.pr ? ` on #${item.pr.number}` : ""}. ${group.settings.order === "queue" ? "It joins the queue once approved" : "It merges once approved and green"}`,
    );
  else if (entry.waitingFor === "ci") lines.push("Waiting for CI on the pull request's commit");
  const own = entry.settings;
  if (
    own.rule &&
    (own.order !== group.settings.order || own.mainMoved !== group.settings.mainMoved)
  )
    lines.push(
      own.order !== "queue"
        ? `${own.rule} rule: merges when green`
        : own.mainMoved === "closeout"
          ? `${own.rule} rule: Closeout checks it again after its branch update`
          : `${own.rule} rule: re-check ${recheck(own)}`,
    );
  return lines.join(" · ");
}

function outcome(snapshot: StatusSnapshot, entry: StatusMergeOutcome): string {
  const item = snapshot.items.find((candidate) => candidate.id === entry.itemId);
  const state =
    entry.outcome === "merged"
      ? statePill("merged", "Merged")
      : statePill("warn", "Back with the agent");
  const why =
    entry.outcome === "merged"
      ? `merged ${ago(entry.at, snapshot.generatedAt)}`
      : `${entry.reason === "conflict" ? "the branch update conflicted" : "CI failed"} ${ago(entry.at, snapshot.generatedAt)}`;
  return `<li data-merge-outcome="${esc(entry.itemId)}"><div class="between"><span>${issueLink(item, entry.itemId)} ${pullLink(item)}</span>${state}</div><p class="muted">${esc(why[0]!.toUpperCase() + why.slice(1))}.</p></li>`;
}

function issueLink(item: StatusItem | undefined, id: string): string {
  const href = routeHref({ view: "issues", id });
  return `<a class="work-title" href="${href}"><span class="lin-id">${esc(id)}</span> ${esc(item?.title ?? "")}</a>`;
}

function pullLink(item: StatusItem | undefined): string {
  if (!item?.pr) return "";
  const href = safeHref(item.pr.url);
  return href
    ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" aria-label="Pull request ${item.pr.number}">#${item.pr.number}</a>`
    : `#${item.pr.number}`;
}

/** "35m", "2h 10m": how long since Closeout accepted it. */
function waited(iso: string, now: string): string {
  const since = ago(iso, now);
  return since === "just now" ? "under a minute" : since.replace(/ ago$/, "");
}
