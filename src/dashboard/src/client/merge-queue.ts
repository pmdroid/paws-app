import type {
  MergeQueueIssue,
  MergeQueueResponse,
  MergeWaitReason,
  StatusMergeEntry,
  StatusMergeOutcome,
  StatusMergeSettings,
  StatusMergeStep,
  StepState,
} from "../contract";
import { ago, esc, safeHref, statePill } from "./format";
import { routeHref } from "./route";

export type LaneFilter = "all" | "mine";

/** Every task Closeout accepted that waits to merge, one card per lane: person, project, repository. */
export function renderMergeQueue(
  queue: MergeQueueResponse,
  lanes: { filter: LaneFilter; userId: string | null } = { filter: "all", userId: null },
): string {
  const mine = lanes.userId !== null && lanes.filter === "mine";
  const shown = groups(queue).filter((group) => !mine || group.ownerId === lanes.userId);
  const button = (value: LaneFilter, label: string) =>
    `<button type="button" class="btn${lanes.filter === value ? " on" : ""}" data-action="merge-lanes" data-merge-lanes="${value}" aria-pressed="${lanes.filter === value}">${label}</button>`;
  const toggle =
    lanes.userId === null
      ? ""
      : `<div class="row" role="group" aria-label="Filter lanes">${button("all", "All lanes")}${button("mine", "My lanes")}</div>`;
  const intro = `<div class="between"><p>Accepted pull requests merge in their lane, in the order Closeout accepted them.</p>${toggle}</div>`;
  if (!shown.length)
    return `${intro}<div class="empty" role="status"><p>${mine ? "None of your lanes has work waiting to merge." : "Nothing is waiting to merge."}</p><p class="muted">Pull requests appear here once Closeout accepts them.</p></div>`;
  return `${intro}${shown.map((group) => section(queue, group)).join("")}`;
}

type Group = {
  key: string;
  title: string;
  ownerId: string | null;
  /** Null gathers the tasks Paws knows no repository for. */
  repository: string | null;
  settings: StatusMergeSettings;
  waiting: StatusMergeEntry[];
  history: StatusMergeOutcome[];
};

function groups(queue: MergeQueueResponse): Group[] {
  const byLane = new Map<string, Group>();
  const group = (entry: StatusMergeEntry | StatusMergeOutcome): Group => {
    const item = queue.issues.find((candidate) => candidate.id === entry.itemId);
    const ownerId = item?.ownerId ?? null;
    const key = JSON.stringify([entry.repository, item?.project?.id, ownerId ?? item?.owner]);
    let found = byLane.get(key);
    if (!found) {
      const title = `${item?.owner ?? "Nobody"} · ${item?.project?.name ?? "No project"}`;
      const { repository, settings } = entry;
      found = { key, title, ownerId, repository, settings, waiting: [], history: [] };
      byLane.set(key, found);
    }
    return found;
  };
  for (const entry of queue.entries) group(entry).waiting.push(entry);
  for (const entry of queue.history) group(entry).history.push(entry);
  for (const found of byLane.values()) {
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
  return [...byLane.values()].sort((left, right) =>
    left.repository === right.repository
      ? left.title.localeCompare(right.title)
      : left.repository === null
        ? 1
        : right.repository === null
          ? -1
          : left.repository.localeCompare(right.repository),
  );
}

function section(queue: MergeQueueResponse, group: Group): string {
  const { repository } = group;
  const queued = group.settings.order === "queue";
  const id = `merge-lane-${group.key.replace(/[^A-Za-z0-9-]/g, "-")}`;
  const head = group.waiting.find(
    (entry) =>
      entry.position === 1 || (!queued && repository !== null && group.waiting.length === 1),
  );
  const rest = group.waiting.filter((entry) => entry !== head);
  const card = head ? headCard(queue, group, head) : "";
  const table = rest.length
    ? `<table class="run-table merge-table"><thead><tr>${queued ? `<th class="run-cell">#</th>` : ""}<th class="run-cell">Issue</th><th class="run-cell">PR</th><th class="run-cell hide-phone">Waiting</th><th class="run-cell">Step</th><th class="run-cell hide-phone">Detail</th></tr></thead><tbody>${rest.map((entry) => row(queue, group, entry)).join("")}</tbody></table>`
    : head
      ? ""
      : `<p class="muted">No pull requests waiting.</p>`;
  const done = group.history.length
    ? `<h3>Done and stopped</h3><ul class="overview-work" role="list">${group.history.map((entry) => outcome(queue, entry)).join("")}</ul>`
    : "";
  return `<section class="card col merge-repo min-w-0" data-merge-lane="${esc(group.key)}" aria-labelledby="${esc(id)}"><div class="between"><h2 id="${esc(id)}" class="min-w-0 break-words">${esc(group.title)}</h2><span class="muted min-w-0 break-words">${repository === null ? "Repository not known" : esc(repository)}</span></div>${repository === null ? "" : `<div class="row">${settingsTags(group.settings)}</div>`}${repository === null ? `<p class="muted">Paws has no repository for these tasks.</p>` : queued ? "" : `<p class="muted">No queue here: each pull request merges when green.</p>`}${card}${table}${done}</section>`;
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
  if (settings.mainMoved === "green") return "none, merges on green CI";
  return "CI only";
}

const STEP: Record<MergeWaitReason, { label: string; state: string }> = {
  ahead: { label: "Queued", state: "queued" },
  ci: { label: "Waiting for CI", state: "running" },
  review: { label: "Waiting for review", state: "warn" },
  branch_update: { label: "Updating branch", state: "running" },
  closeout: { label: "Closeout re-check", state: "verifying" },
};

/** What the head waits on, after "waiting on" in its predicate line. */
const WAITING_ON: Record<MergeWaitReason, string> = {
  ahead: "the pull requests ahead",
  ci: "ci",
  review: "review",
  branch_update: "branch update",
  closeout: "Closeout re-check",
};

/** A step's glyph, in the color `statePill` gives its state. A step has no failed state, so no ✗. */
const GLYPH: Record<StepState, { glyph: string; color: string }> = {
  done: { glyph: "✓", color: "text-state-ok" },
  run: { glyph: "◌", color: "text-state-running" },
  wait: { glyph: "◌", color: "text-muted-foreground" },
};

/** The head of a repository's queue: what `mergeable` waits on, one tile per step. */
function headCard(queue: MergeQueueResponse, group: Group, entry: StatusMergeEntry): string {
  const item = queue.issues.find((candidate) => candidate.id === entry.itemId);
  const merging = isMerging(entry);
  const verdict = merging
    ? `<span class="text-state-ok">= true · merging</span>`
    : `<span class="text-state-awaiting">= false · waiting on ${esc(WAITING_ON[entry.waitingFor])}</span>`;
  const tiles = entry.steps.length
    ? `<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">${entry.steps.map(tile).join("")}</div>`
    : "";
  const sentence = detail(group, entry, item);
  return `<section class="card merge-head" data-merge-head="${esc(entry.itemId)}" aria-label="${esc(`Head of the queue: ${entry.itemId}`)}"><div class="col"><div class="between"><span>${issueLink(item, entry.itemId)}</span><span class="row min-w-0">${pullLink(item)}${stepPill(group, entry)}</span></div><div class="font-mono text-base break-words">mergeable(${esc(entry.itemId)}) ${verdict}</div>${tiles}<div class="row">${settingsTags(entry.settings)}</div>${sentence ? `<p class="muted">${esc(sentence)}.</p>` : ""}</div></section>`;
}

function tile(step: StatusMergeStep): string {
  const glyph = GLYPH[step.state];
  return `<div class="border border-border rounded-base px-3 py-2 font-mono text-xs flex min-w-0 items-baseline gap-2" data-merge-step="${esc(step.state)}"><span class="${glyph.color}" aria-hidden="true">${glyph.glyph}</span><span class="sr-only">${esc(step.state)}:</span><span class="min-w-0 break-words">${esc(step.name)}${step.detail ? ` <span class="text-muted-foreground">${esc(step.detail)}</span>` : ""}</span></div>`;
}

function row(queue: MergeQueueResponse, group: Group, entry: StatusMergeEntry): string {
  const item = queue.issues.find((candidate) => candidate.id === entry.itemId);
  const queued = group.settings.order === "queue";
  const position = queued
    ? `<td class="run-cell">${entry.position === null ? `<span class="muted" aria-label="No place yet">–</span>` : String(entry.position)}</td>`
    : "";
  return `<tr data-merge-item="${esc(entry.itemId)}">${position}<td class="run-cell">${issueLink(item, entry.itemId)}</td><td class="run-cell">${pullLink(item)}</td><td class="run-cell hide-phone"><span class="muted" title="Closeout accepted ${esc(entry.acceptedAt)}">${esc(waited(entry.acceptedAt, queue.generatedAt))}</span></td><td class="run-cell">${stepPill(group, entry)}</td><td class="run-cell hide-phone">${esc(detail(group, entry, item))}</td></tr>`;
}

function isMerging(entry: StatusMergeEntry): boolean {
  return entry.steps.length > 0 && entry.steps.every((step) => step.state === "done");
}

/** "Merging · batch of 2", "Waiting for CI · 4 of 6 checks", "After ENG-1: both change a.ts". */
function stepPill(group: Group, entry: StatusMergeEntry): string {
  if (isMerging(entry)) {
    const batch = group.waiting.filter(isMerging).length;
    return statePill("ok", batch > 1 ? `Merging · batch of ${batch}` : "Merging");
  }
  const step = STEP[entry.waitingFor];
  const checks = /(\d+) of (\d+) checks/.exec(entry.detail ?? "");
  const label =
    entry.waitingFor === "ci" && checks
      ? `${step.label} · ${checks[1]} of ${checks[2]} checks`
      : entry.waitingFor === "ahead" && entry.after
        ? `After ${entry.after.itemId}${entry.after.files[0] ? `: both change ${entry.after.files[0].split("/").pop()}` : ""}`
        : step.label;
  return `<span class="inline-flex min-w-0 max-w-full [&_.st]:max-w-full [&_.st]:whitespace-normal">${statePill(step.state, label)}</span>`;
}

function detail(group: Group, entry: StatusMergeEntry, item: MergeQueueIssue | undefined): string {
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

function outcome(queue: MergeQueueResponse, entry: StatusMergeOutcome): string {
  const item = queue.issues.find((candidate) => candidate.id === entry.itemId);
  const state =
    entry.outcome === "merged"
      ? statePill("merged", "Merged")
      : statePill(
          "warn",
          `${entry.reason === "conflict" ? "Merge conflict" : "CI failed"} · sent back to the agent`,
        );
  const why =
    entry.outcome === "merged"
      ? `merged ${ago(entry.at, queue.generatedAt)}`
      : `${entry.reason === "conflict" ? "the branch update conflicted" : "CI failed"} ${ago(entry.at, queue.generatedAt)}`;
  return `<li data-merge-outcome="${esc(entry.itemId)}"><div class="between"><span>${issueLink(item, entry.itemId)} ${pullLink(item)}</span>${state}</div><p class="muted">${esc(why[0]!.toUpperCase() + why.slice(1))}.</p></li>`;
}

function issueLink(item: MergeQueueIssue | undefined, id: string): string {
  const href = routeHref({ view: "issues", id });
  return `<a class="work-title" href="${href}"><span class="lin-id">${esc(id)}</span> ${esc(item?.title ?? "")}</a>`;
}

function pullLink(item: MergeQueueIssue | undefined): string {
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
