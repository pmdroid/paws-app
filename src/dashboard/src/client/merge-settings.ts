import { journalCaught } from "../journal";
import { MERGE_QUEUE_API_PATH, parseMergeQueueResponse } from "../contract";
import { renderMarkup } from "./theme";
import type {
  CommentWait,
  HighRiskRepository,
  HotFile,
  IgnoredComments,
  LaneItem,
  MainMoved,
  MergeChoice,
  MergeLaneSplit,
  MergeNoProject,
  MergeOrder,
  MergeSettings,
  MergeSettingsView,
} from "../merge-settings";
import type { AgentSettings } from "../agent-settings";
import { settingsRequest } from "./agent-settings";
import { esc } from "./format";
import { readCsrfToken } from "./csrf";
import { routeHref } from "./route";

const CI_FIX_ATTEMPTS_DEFAULT = 3;
const CI_FIX_ATTEMPTS_MAX = 10;

const ORDERS: Record<MergeOrder, string> = {
  queue: "Merge queue: one pull request at a time, in order",
  "ci-green": "Merge each pull request when its CI is green",
  "github-queue": "Add to the GitHub merge queue",
};
const MAIN_MOVED: Record<MainMoved, string> = {
  overlap: "Update and re-test only when main changed the same files or package",
  green: "Merge on green CI without updating the branch onto main",
  ci: "Always update the branch and wait for CI",
  closeout: "Always update the branch and run Closeout again",
};
const ORDER_HELP: Record<MergeOrder, string> = {
  queue: "Pull requests in the same repository merge in the order they became ready.",
  "ci-green": "Each pull request merges on its own once its CI is green.",
  "github-queue": "Only for repositories whose base branch has a GitHub merge queue.",
};
const MAIN_MOVED_HELP: Record<MainMoved, string> = {
  overlap: "Needs GitHub's “Require branches to be up to date” rule off for this repository.",
  green:
    "Main's new commits are not tested with this change before it merges. Needs GitHub's “Require branches to be up to date” rule off.",
  ci: "Closeout does not run again after the branch update.",
  closeout: "A Closeout re-check starts with a fresh retry budget.",
};

type View = {
  data: MergeSettingsView | null;
  busy: string | null;
  error: string | null;
  field?: string;
  saved: boolean;
  denied?: boolean;
  ciFix?: { attempts: number; stored: number } | { error: string };
  queue?: LaneItem[];
};

const LANE_SPLITS: Record<MergeLaneSplit, string> = {
  project: "Linear project",
  person: "Person who delegated the issue",
};
const NO_PROJECT: Record<MergeNoProject, string> = {
  own: "Each issue merges on its own",
  lane: "One lane, like a project",
};
const PARALLEL = [1, 3, 5];

export function laneNames(
  items: readonly LaneItem[],
  lanes: readonly MergeLaneSplit[],
  noProject: MergeNoProject,
): string[] {
  const repositories = new Set(items.map((item) => item.repository));
  const names = items.map((item) => {
    const parts =
      repositories.size > 1 ? [item.repository?.split("/").pop() ?? "No repository"] : [];
    if (item.project === null && noProject === "own") return [...parts, item.id].join(" · ");
    if (lanes.includes("project")) parts.push(item.project ?? "No project");
    if (lanes.includes("person")) parts.push(item.owner ?? "No owner");
    return (parts.length ? parts : [item.repository ?? "No repository"]).join(" · ");
  });
  return [...new Set(names)];
}

function lanePreview(data: MergeSettingsView, queue: readonly LaneItem[] | undefined): string {
  if (!queue) return "";
  const names = laneNames(queue, data.lanes ?? [], data.noProject ?? "own");
  return names.length
    ? `Lanes now: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`
    : "No pull request is in the merge queue now.";
}

function lanesSection(data: MergeSettingsView, queue: readonly LaneItem[] | undefined): string {
  const lanes = data.lanes ?? [];
  const noProject = data.noProject ?? "own";
  const check = (name: string, label: string, on: boolean, extra = "", type = "checkbox") =>
    `<label class="flex min-w-0 items-start gap-2"><input type="${type}" name="${name}"${on ? " checked" : ""}${extra}><span class="min-w-0 break-words">${esc(label)}</span></label>`;
  const splits = `<fieldset class="settings-field min-w-0"><legend>Give each lane its own</legend>${check("lane-repository", "Repository", true, " disabled")}${(Object.entries(LANE_SPLITS) as [MergeLaneSplit, string][]).map(([split, label]) => check(`lane-${split}`, label, lanes.includes(split))).join("")}<small class="sub break-words" id="merge-lanes-preview">${esc(lanePreview(data, queue))}</small></fieldset>`;
  const radios =
    data.noProject === undefined
      ? ""
      : `<fieldset class="settings-field min-w-0"><legend>Issues without a project</legend>${(Object.entries(NO_PROJECT) as [MergeNoProject, string][]).map(([value, label]) => check("lane-no-project", label, value === noProject, ` value="${value}"`, "radio")).join("")}</fieldset>`;
  const parallel = data.parallel ?? 1;
  const counts = [...new Set([...PARALLEL, parallel])].sort((a, b) => a - b);
  const batch = `<div class="settings-field min-w-0"><label for="merge-parallel">Merges at once in a lane</label><select id="merge-parallel" name="merge-parallel" aria-describedby="merge-parallel-help"${data.parallel === undefined ? " disabled" : ""}>${counts.map((count) => `<option value="${count}"${count === parallel ? " selected" : ""}>${count}</option>`).join("")}</select><small class="sub" id="merge-parallel-help">${data.parallel === undefined ? "This Paws merges one pull request of a lane at a time." : "Green pull requests that change none of the same files merge together."}</small>${check("merge-batch-check", "Check main after a batch", true, ' disabled aria-describedby="merge-batch-check-help"')}<small class="sub" id="merge-batch-check-help">When main's CI fails after a batch, the lane merges one at a time until main is green again.</small></div>`;
  return `<section class="settings-section" id="merge-lanes"><div class="settings-label"><h2>Merge lanes</h2><p class="sub">Pull requests in one lane merge in order. Lanes don't wait for each other.</p></div><div class="col min-w-0">${splits}${radios}${batch}</div></section>`;
}

export function ciFixProblem(attempts: number): string | null {
  return Number.isInteger(attempts) && attempts >= 0 && attempts <= CI_FIX_ATTEMPTS_MAX
    ? null
    : `CI fix attempts: enter a whole number from 0 to ${CI_FIX_ATTEMPTS_MAX}.`;
}

function options<T extends string>(names: Partial<Record<T, string>>, selected: T): string {
  return (Object.entries(names) as [T, string][])
    .map(
      ([value, name]) =>
        `<option value="${value}" ${value === selected ? "selected" : ""}>${esc(name)}</option>`,
    )
    .join("");
}

/**
 * The merge orders a level may choose. "Add to the GitHub merge queue" is offered only when a
 * configured repository has one, or when the level already uses it.
 */
function orderNames(
  queues: readonly string[],
  selected: MergeOrder,
): Partial<Record<MergeOrder, string>> {
  if (queues.length > 0 || selected === "github-queue") return ORDERS;
  const { "github-queue": _hidden, ...offered } = ORDERS;
  return offered;
}

function orderHelp(order: MergeOrder, queues: readonly string[]): string {
  if (order !== "github-queue") return ORDER_HELP[order];
  if (queues.length === 0)
    return "No configured repository has a GitHub merge queue, so Paws merges each pull request itself when its CI is green.";
  return `GitHub's merge queue on ${queues.join(", ")}. A repository without one merges each pull request when its CI is green.`;
}

function mainMovedHelp(choice: MainMoved, upToDate: readonly string[]): string {
  if (choice !== "overlap" || upToDate.length === 0) return MAIN_MOVED_HELP[choice];
  return `GitHub requires branches to be up to date in ${upToDate.join(", ")}, so merges there always update the branch and wait for CI. Turn that rule off to merge without an update.`;
}

function choiceFields(
  scope: string,
  choice: MergeChoice,
  repos: { queues: readonly string[]; upToDate: readonly string[] },
): string {
  return `<div class="settings-controls"><div class="settings-field"><label for="${scope}-order">Merge order</label><select id="${scope}-order" name="${scope}-order" aria-describedby="${scope}-order-help">${options(orderNames(repos.queues, choice.order), choice.order)}</select><small class="sub" id="${scope}-order-help">${esc(orderHelp(choice.order, repos.queues))}</small></div>
    <div class="settings-field"><label for="${scope}-main">When main moved before the merge</label><select id="${scope}-main" name="${scope}-main" aria-describedby="${scope}-main-help">${options(MAIN_MOVED, choice.mainMoved)}</select><small class="sub" id="${scope}-main-help">${esc(mainMovedHelp(choice.mainMoved, repos.upToDate))}</small></div></div>`;
}

/** The globs in a High-risk paths box: one per line, blank lines dropped. */
export function riskGlobs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

export function markerLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim() !== "");
}

/** The repository's own `.paws/high-risk-paths`, read-only. */
function riskFile(file: HighRiskRepository["file"]): string {
  if (file.state === "unavailable") return `<p class="sub">${esc(file.reason)}</p>`;
  const at = `<span class="mono">${esc(file.commit.slice(0, 7))}</span>`;
  if (file.state === "missing")
    return `<p class="sub">No file on <span class="mono">origin/main</span> at ${at}. Add one to the repository to mark paths high-risk there.</p>`;
  return `${
    file.paths.length
      ? `<ul class="risk-file">${file.paths.map((glob) => `<li><code>${esc(glob)}</code></li>`).join("")}</ul>`
      : '<p class="sub">The file lists no glob.</p>'
  }<p class="sub">Read-only, from <span class="mono">origin/main</span> at ${at}. Change it in the repository.</p>`;
}

function riskSection(repositories: readonly HighRiskRepository[]): string {
  const body = repositories.length
    ? repositories
        .map(
          (entry, index) =>
            `<section class="settings-project"><h3>${esc(entry.repository)}</h3><div class="risk-lists"><div class="settings-field"><label for="risk-${index}">Paws settings</label><textarea id="risk-${index}" name="risk-${index}" rows="4" spellcheck="false" autocapitalize="none" placeholder="src/auth/**" aria-describedby="risk-${index}-help">${esc(entry.paths.join("\n"))}</textarea><small class="sub" id="risk-${index}-help">One glob per line, relative to the repository root.</small></div><div class="settings-field"><span class="settings-field-title">.paws/high-risk-paths</span>${riskFile(entry.file)}</div></div></section>`,
        )
        .join("")
    : '<p class="sub">No repositories yet. Connect one under Integrations.</p>';
  return `<section class="settings-section"><div class="settings-label"><h2>High-risk paths</h2><p class="sub">A changed path is high-risk when a glob here or in the repository's <span class="mono">.paws/high-risk-paths</span> matches it. The file can only add paths. The Risk card on each issue names the list that matched.</p></div><div class="col">${body}</div></section>`;
}

const IGNORED_LISTS = [
  {
    key: "ignoreCommentBots",
    name: "ignore-bots",
    title: "Bot accounts",
    placeholder: "codecov[bot]",
    lines: riskGlobs,
    help: "Ignore every comment from this account. Use markers instead when the account also posts real failures.",
  },
  {
    key: "ignoreCommentMarkers",
    name: "ignore-markers",
    title: "Comment markers",
    placeholder: "<!-- deploy-security-proof -->",
    lines: markerLines,
    help: "A comment that contains this text is ignored, for example <code>&lt;!-- deploy-security-proof --&gt;</code>.",
  },
] as const;

export function fieldProblem(message: string): string {
  const text = message.replace(/^ignoredComments\.\d+\.\w+(?:\.(\d+))?\s*/, (_, line) =>
    line === undefined ? "" : `Line ${Number(line) + 1} `,
  );
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function ignoredSection(repositories: readonly IgnoredComments[], view: View): string {
  const body = repositories.length
    ? repositories
        .map((entry, index) => {
          const fields = IGNORED_LISTS.map((list) => {
            const id = `${list.name}-${index}`;
            const problem =
              view.error && view.field === `ignoredComments.${index}.${list.key}`
                ? fieldProblem(view.error)
                : null;
            return `<div class="settings-field"><label for="${id}">${list.title}</label><textarea id="${id}" name="${id}" rows="4" spellcheck="false" autocapitalize="none" placeholder="${esc(list.placeholder)}" aria-describedby="${id}-help${problem ? ` ${id}-error` : ""}"${problem ? ' aria-invalid="true"' : ""}>${esc(entry[list.key].join("\n"))}</textarea><small class="sub" id="${id}-help">${list.help}</small>${problem ? `<small class="err" id="${id}-error" role="alert">${esc(problem)}</small>` : ""}</div>`;
          }).join("");
          return `<section class="settings-project"><h3>${esc(entry.repository)}</h3><div class="risk-lists">${fields}</div></section>`;
        })
        .join("")
    : '<p class="sub">No repositories yet. Connect one under Integrations.</p>';
  return `<section class="settings-section" id="merge-ignored-comments"><div class="settings-label"><h2>Ignored PR comments</h2><p class="sub">Comments that only report status, so they never send the pull request back to the agent. One entry per line. Applies to the next comment.</p></div><div class="col">${body}</div></section>`;
}

export function renderMergeSettings(view: View): string {
  if (view.denied) return '<p class="sub">Only workspace admins can change merging settings.</p>';
  const intro = '<p class="sub">An item keeps the settings it had when it started.</p>';
  if (!view.data)
    return `${intro}<div class="settings-message" role="${view.error ? "alert" : "status"}">${esc(view.error ?? "Loading merging settings…")}</div>${view.error ? '<button class="btn" type="button" data-merge="reload">Try again</button>' : ""}`;
  const data = view.data;
  const repos = { queues: data.githubQueue?.repositories ?? [], upToDate: data.upToDateRule ?? [] };
  const feedback = view.error
    ? `<p class="settings-message err" role="alert">${esc(view.field?.startsWith("ignoredComments.") ? "Merging settings were not saved. Fix the field marked under Ignored PR comments." : view.error)}</p>`
    : view.saved
      ? '<p class="settings-message" role="status">Merging settings saved. Items that start from now on use them.</p>'
      : "";
  return `${intro}${data.githubQueueError ? `<p class="settings-message" role="status">${esc(data.githubQueueError)}</p>` : ""}<form id="merge-settings-form"><div id="merge-feedback">${feedback}</div>
    <fieldset class="settings-fields" ${view.busy ? "disabled" : ""}>
      <section class="settings-section"><div class="settings-label"><h2>Merging</h2><p class="sub">Used by every project.</p></div><div class="col">${choiceFields("default", data.default, repos)}</div></section>
      ${data.lanes ? lanesSection(data, view.queue) : ""}
      ${data.commentWait ? commentWaitSection(data.commentWait) : ""}
      ${checksSection(view.ciFix)}
      ${sessionSection(data)}
      ${riskGateSection(data.riskGate)}
      ${data.autoApproveHighRisk === undefined ? "" : `<section class="settings-section"><div class="settings-label"><h2>High-risk approval</h2><p class="sub" id="auto-approve-high-risk-help">Off by default. When on, a high-risk change can merge without a person only when Closeout accepted the exact commit, neither security nor independent review has a P2-or-worse finding, including in pre-existing code, and no rule probe failed. A new commit needs its own reviews. Changes to the risk rules or agent instructions still need a person.${data.riskGate?.on === true ? "" : " Turn on the risk gate before changing this setting."}</p></div><div class="col"><label><input type="checkbox" name="auto-approve-high-risk" aria-describedby="auto-approve-high-risk-help"${data.autoApproveHighRisk ? " checked" : ""}${data.riskGate?.on === true ? "" : " disabled"}> Let high-risk changes through when both reviews are clean</label></div></section>`}
      ${data.highRiskRepositories ? riskSection(data.highRiskRepositories) : ""}
      ${data.ignoredComments ? ignoredSection(data.ignoredComments, view) : ""}
      ${data.hotFiles ? hotFileSection(data.hotFiles, data.parallelFiles !== undefined) : ""}
      <div class="settings-actions"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-merge="reload">Discard changes</button></div>
    </fieldset>${view.busy ? `<p class="settings-message" role="status">${esc(view.busy)}</p>` : ""}</form>`;
}

const HOT_FILES_SHOWN = 10;

function issueLink(id: string): string {
  return `<a class="lin-id" href="${esc(routeHref({ view: "issues", id }))}">${esc(id)}</a>`;
}

const MIGRATION_META = /^src\/db\/drizzle[^/]*\/meta\/[^/]+$/;

function hotFileRow(file: HotFile, editable: boolean): string {
  const held = file.held !== false;
  const holds = held
    ? (file.holds ?? [])
        .map(
          (hold) => `<p>Holding ${issueLink(hold.held)} until ${issueLink(hold.holder)} merges</p>`,
        )
        .join("")
    : "";
  const toggle = `<label><input type="checkbox" name="hot-hold" data-repository="${esc(file.repository)}" data-path="${esc(file.path)}"${held ? " checked" : ""}${editable ? "" : " disabled"}> Hold work that changes this file</label>${held ? "" : '<span class="sub">Not held</span>'}${MIGRATION_META.test(file.path) ? '<p class="sub">Migrations made side by side need a manual rebase</p>' : ""}`;
  return `<li class="hot-file${held ? "" : " opacity-60"}"><code>${esc(file.path)}</code><span class="sub">${esc(file.repository)} · ${file.conflicts} ${file.conflicts === 1 ? "conflict" : "conflicts"} in 7 days</span><span class="row wrap">${file.items.map(issueLink).join("")}</span>${toggle}${holds}</li>`;
}

function hotFileSection(files: readonly HotFile[], editable: boolean): string {
  const sorted = [...files].sort(
    (left, right) =>
      Number(Boolean(right.holds?.length)) - Number(Boolean(left.holds?.length)) ||
      right.conflicts - left.conflicts,
  );
  const rows = (list: readonly HotFile[]) =>
    `<ul class="risk-file">${list.map((file) => hotFileRow(file, editable)).join("")}</ul>`;
  const rest = sorted.slice(HOT_FILES_SHOWN);
  const body = sorted.length
    ? `${rows(sorted.slice(0, HOT_FILES_SHOWN))}${rest.length ? `<details><summary>Show all ${sorted.length}</summary>${rows(rest)}</details>` : ""}`
    : '<p class="sub">No merge conflicts in the last 7 days, so nothing is held back.</p>';
  return `<section class="settings-section" id="merge-hot-files"><div class="settings-label"><h2>Conflict-prone files</h2><p class="sub">These files caused merge conflicts in the last 7 days. Paws starts only one item at a time that changes them, so the next one doesn't hit the same conflict.</p></div><div class="col min-w-0">${body}</div></section>`;
}

/** Whether high-risk pull requests wait for an approval in Paws, and why not. */
function commentWaitSection(wait: CommentWait): string {
  const field = (name: string, id: string, title: string, value: number, help: string) =>
    `<div class="settings-field"><label for="${id}">${title}</label><input id="${id}" name="${name}" type="number" inputmode="numeric" min="0" max="3600" step="1" value="${value}" aria-describedby="${id}-help"><small class="sub" id="${id}-help">${help}</small></div>`;
  return `<section class="settings-section" id="merge-comment-wait"><div class="settings-label"><h2>Pull request comments</h2><p class="sub">How long Paws collects review comments, changes-requested reviews and bot reviews on a pull request before it sends them to the agent in one fix round. Applies to the next comment.</p></div><div class="col"><div class="settings-controls">${field(
    "comment-quiet",
    "merge-comment-quiet",
    "Quiet time (seconds)",
    wait.quietSeconds,
    "Wait this long after the latest comment or review.",
  )}${field(
    "comment-max",
    "merge-comment-max",
    "Longest wait (seconds)",
    wait.maxWaitSeconds,
    "Send them anyway this long after the first one, even while comments keep coming.",
  )}</div></div></section>`;
}

function checksSection(ciFix: View["ciFix"]): string {
  if (!ciFix) return "";
  const label = `<div class="settings-label"><h2>Pull request checks</h2><p class="sub">When CI fails on a pull request, Paws sends the failing checks and their links back to the implementing agent. After the last attempt, Paws asks in the issue's Linear session.</p></div>`;
  if ("error" in ciFix)
    return `<section class="settings-section" id="merge-pull-request-checks">${label}<div class="col"><p class="settings-message err" role="status">${esc(ciFix.error)}</p></div></section>`;
  const { attempts } = ciFix;
  const problem = ciFixProblem(attempts);
  return `<section class="settings-section" id="merge-pull-request-checks">${label}<div class="col">
      <label for="merge-ci-fix-attempts">CI fix attempts</label><input id="merge-ci-fix-attempts" name="merge-ci-fix-attempts" type="number" inputmode="numeric" min="0" max="${CI_FIX_ATTEMPTS_MAX}" step="1" required value="${Number.isFinite(attempts) ? attempts : ""}" aria-describedby="merge-ci-fix-attempts-help${problem ? " merge-ci-fix-attempts-error" : ""}"${problem ? ' aria-invalid="true"' : ""}>
      <p class="sub" id="merge-ci-fix-attempts-help">From 0 to ${CI_FIX_ATTEMPTS_MAX}. With 0, Paws asks in Linear on the first failure.</p>${problem ? `<small class="err" id="merge-ci-fix-attempts-error" role="alert">${esc(problem)}</small>` : ""}</div></section>`;
}

function sessionSection(data: MergeSettingsView): string {
  if (!data.sessionDone) return "";
  const choices = {
    pull_request: "When the pull request opens",
    ci_green: "When CI is green",
    settled: "When CI is green and the pull request has been quiet",
  };
  return `<section class="settings-section" id="merge-session"><div class="settings-label"><h2 id="merge-session-title">When Paws finishes the Linear session</h2></div><div class="col"><div class="col" role="radiogroup" aria-labelledby="merge-session-title" aria-describedby="merge-session-help">${Object.entries(
    choices,
  )
    .map(
      ([value, label]) =>
        `<label><input type="radio" name="session-done" value="${value}"${data.sessionDone === value ? " checked" : ""}> ${label}</label>`,
    )
    .join(
      "",
    )}</div><p class="sub" id="merge-session-help">Linear notifies you when the session finishes. Paws keeps fixing review comments and CI either way.</p>${data.sessionDone === "settled" ? `<div class="settings-field"><label for="merge-session-quiet">Quiet for, minutes</label><input id="merge-session-quiet" name="session-quiet" type="number" inputmode="numeric" min="1" max="120" step="1" required value="${data.sessionQuietMinutes ?? 10}"></div>` : ""}</div></section>`;
}

function storedCiFix(settings: AgentSettings): number {
  return settings.merge?.ciFixAttempts ?? CI_FIX_ATTEMPTS_DEFAULT;
}

function riskGateSection(gate: MergeSettingsView["riskGate"]): string {
  if (!gate) return "";
  const body = gate.on
    ? '<p class="sub">A pull request that changes a high-risk path waits for an approval on its issue page in Paws before it joins the merge queue.</p>'
    : `<p class="settings-message" role="status">${esc(gate.reason ?? "The risk gate is off.")}</p>`;
  return `<section class="settings-section" id="merge-risk-gate"><div class="settings-label"><h2>High-risk approval</h2><p class="sub">The person who delegated the issue or the project lead approves each high-risk head.</p></div><div class="col">${body}</div></section>`;
}

/**
 * The saved body: the page's settings without the Linear choices. High-risk paths go along only
 * when the page listed them, so an engine that does not list them keeps its own.
 */
export function mergeSettingsBody(data: MergeSettingsView): MergeSettings {
  return {
    ...(data.autoApproveHighRisk === undefined
      ? {}
      : { autoApproveHighRisk: data.autoApproveHighRisk }),
    default: data.default,
    ...(data.sessionDone ? { sessionDone: data.sessionDone } : {}),
    ...(data.sessionDone === "settled"
      ? { sessionQuietMinutes: data.sessionQuietMinutes ?? 10 }
      : {}),
    ...(data.lanes ? { lanes: data.lanes } : {}),
    ...(data.noProject ? { noProject: data.noProject } : {}),
    ...(data.parallel === undefined ? {} : { parallel: data.parallel }),
    ...(data.commentWait ? { commentWait: data.commentWait } : {}),
    ...(data.highRiskRepositories
      ? {
          highRiskPaths: data.highRiskRepositories.map((entry) => ({
            repository: entry.repository,
            paths: entry.paths,
          })),
        }
      : {}),
    ...(data.ignoredComments ? { ignoredComments: data.ignoredComments } : {}),
    ...(data.parallelFiles ? { parallelFiles: data.parallelFiles } : {}),
  };
}

function parallelToggle(
  lists: readonly { repository: string; paths: string[] }[],
  repository: string,
  path: string,
  parallel: boolean,
): { repository: string; paths: string[] }[] {
  const key = repository.toLowerCase();
  const current = lists.find((entry) => entry.repository.toLowerCase() === key);
  const rest = (current?.paths ?? []).filter((entry) => entry !== path);
  const paths = parallel ? [...rest, path] : rest;
  return [
    ...lists.filter((entry) => entry.repository.toLowerCase() !== key),
    ...(paths.length ? [{ repository: current?.repository ?? repository, paths }] : []),
  ];
}

export async function mergeSettingsRequest(
  engine: string,
  method: "GET" | "PUT",
  body?: MergeSettings,
  csrf = "",
  fetchImpl: typeof fetch = fetch,
): Promise<MergeSettingsView> {
  const response = await fetchImpl(new URL("/api/settings/merging", engine), {
    method,
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(method === "GET" ? {} : { "Content-Type": "application/json", "x-paws-csrf": csrf }),
    },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(
      new Error(
        typeof data.error === "string" ? data.error : `Request failed (${response.status}).`,
        { cause: response.status },
      ),
      typeof data.field === "string" ? { field: data.field } : {},
    );
  return data as MergeSettingsView;
}

export async function mergeQueueItems(
  engine: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LaneItem[] | null> {
  try {
    const response = await fetchImpl(new URL(MERGE_QUEUE_API_PATH, engine), {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const parsed = parseMergeQueueResponse(await response.json());
    if (!parsed.ok) return null;
    const { entries, issues } = parsed.response;
    const issue = (id: string) => issues.find((candidate) => candidate.id === id);
    return entries.map(({ itemId: id, repository }) => ({
      ...{ id, repository, project: issue(id)?.project?.name ?? null },
      owner: issue(id)?.owner ?? null,
    }));
  } catch (error) {
    journalCaught(error, "merge-settings.mergeQueueItems", null);
    return null;
  }
}

export function createMergeSettings(invalidate: () => void): {
  mount(root: HTMLElement, engine: string | null): void;
} {
  let root: HTMLElement | null = null;
  let engine: string | null = null;
  let generation = 0;
  let view: View = { data: null, busy: null, error: null, saved: false };
  const paint = () => {
    if (!root) return;
    const active = document.activeElement;
    const held =
      active instanceof HTMLElement && root.contains(active)
        ? active.id
          ? `#${CSS.escape(active.id)}`
          : active.getAttribute("name")
            ? `[name="${active.getAttribute("name")}"]`
            : null
        : null;
    renderMarkup(root, renderMergeSettings(view));
    if (held) root.querySelector<HTMLElement>(held)?.focus({ preventScroll: true });
  };
  const draft = () => {
    const form = root?.querySelector("form");
    if (!form || !view.data) return;
    const value = (name: string) =>
      form.querySelector<HTMLSelectElement | HTMLInputElement>(`[name="${name}"]`)?.value;
    const read = (scope: string, fallback: MergeChoice): MergeChoice => ({
      order: (value(`${scope}-order`) as MergeOrder | undefined) ?? fallback.order,
      mainMoved: (value(`${scope}-main`) as MainMoved | undefined) ?? fallback.mainMoved,
    });
    const data = view.data;
    data.default = read("default", data.default);
    if (data.sessionDone) {
      data.sessionDone =
        (form.querySelector<HTMLInputElement>('[name="session-done"]:checked')
          ?.value as MergeSettingsView["sessionDone"]) ?? data.sessionDone;
      const quiet = value("session-quiet");
      if (quiet !== undefined) data.sessionQuietMinutes = quiet === "" ? NaN : Number(quiet);
    }
    if (data.lanes)
      data.lanes = (Object.keys(LANE_SPLITS) as MergeLaneSplit[]).filter(
        (split) => form.querySelector<HTMLInputElement>(`[name="lane-${split}"]`)?.checked,
      );
    if (data.noProject)
      data.noProject = form.querySelector<HTMLInputElement>(
        '[name="lane-no-project"][value="lane"]',
      )?.checked
        ? "lane"
        : "own";
    if (data.parallel !== undefined)
      data.parallel = Number(value("merge-parallel") ?? data.parallel);
    if (data.autoApproveHighRisk !== undefined)
      data.autoApproveHighRisk =
        root!.querySelector<HTMLInputElement>('[name="auto-approve-high-risk"]')?.checked ?? false;
    if (data.commentWait) {
      const seconds = (name: string, fallback: number) => {
        const text = value(name)?.trim();
        return text === undefined || text === "" ? fallback : Number(text);
      };
      data.commentWait = {
        quietSeconds: seconds("comment-quiet", data.commentWait.quietSeconds),
        maxWaitSeconds: seconds("comment-max", data.commentWait.maxWaitSeconds),
      };
    }
    data.highRiskRepositories = data.highRiskRepositories?.map((entry, index) => {
      const text = form.querySelector<HTMLTextAreaElement>(`[name="risk-${index}"]`)?.value;
      return text === undefined ? entry : { ...entry, paths: riskGlobs(text) };
    });
    data.ignoredComments = data.ignoredComments?.map((entry, index) => {
      const next = { ...entry };
      for (const list of IGNORED_LISTS) {
        const text = form.querySelector<HTMLTextAreaElement>(
          `[name="${list.name}-${index}"]`,
        )?.value;
        if (text !== undefined) next[list.key] = list.lines(text);
      }
      return next;
    });
    for (const box of form.querySelectorAll<HTMLInputElement>('[name="hot-hold"]')) {
      const { repository = "", path = "" } = box.dataset;
      data.parallelFiles = parallelToggle(data.parallelFiles ?? [], repository, path, !box.checked);
      data.hotFiles = data.hotFiles?.map((file) =>
        file.repository === repository && file.path === path
          ? { ...file, held: box.checked }
          : file,
      );
    }
    if (view.ciFix && "attempts" in view.ciFix) {
      const text = value("merge-ci-fix-attempts")?.trim();
      if (text !== undefined) view.ciFix.attempts = text === "" ? NaN : Number(text);
    }
    view.saved = false;
    view.error = null;
    delete view.field;
  };
  const request = async (busy: string, operation: () => Promise<void>) => {
    const started = generation;
    view.busy = busy;
    view.error = null;
    delete view.field;
    try {
      paint();
      await operation();
    } catch (error) {
      journalCaught(error, "merge-settings.createMergeSettings.paint", null);
      if (started === generation) {
        view.error = error instanceof Error ? error.message : "Could not update merging settings.";
        const field = (error as { field?: unknown }).field;
        if (typeof field === "string") view.field = field;
      }
    } finally {
      if (started === generation) {
        view.busy = null;
        paint();
        invalidate();
      }
    }
  };
  const load = () =>
    request("Loading merging settings…", async () => {
      const started = generation;
      try {
        const [data, ciFix] = await Promise.all([
          mergeSettingsRequest(engine!, "GET"),
          settingsRequest<AgentSettings>(engine!, "GET").then(
            (settings): View["ciFix"] => {
              const stored = storedCiFix(settings);
              return { attempts: stored, stored };
            },
            (error: unknown): View["ciFix"] => {
              journalCaught(error, "merge-settings.createMergeSettings.settingsRequest", null);
              return { error: "CI fix attempts could not be loaded. Reload to try again." };
            },
          ),
        ]);
        if (started !== generation) return;
        view = { data, busy: view.busy, error: null, saved: false, ciFix };
        if (data.lanes)
          void mergeQueueItems(engine!).then((queue) => {
            if (started !== generation || !queue) return;
            view.queue = queue;
            const preview = root?.querySelector("#merge-lanes-preview");
            if (preview && view.data) preview.textContent = lanePreview(view.data, queue);
          });
      } catch (error) {
        if (started === generation && error instanceof Error && error.cause === 403) {
          view.denied = true;
          view.data = null;

          journalCaught(error, "merge-settings.createMergeSettings.mergeSettingsRequest", null);
          return;
        }
        throw error;
      }
    });
  const click = (event: Event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-merge]");
    if (!button || view.busy || !engine) return;
    if (button.dataset.merge === "reload") void load();
  };
  const submit = (event: Event) => {
    event.preventDefault();
    if (view.busy || !view.data || !engine) return;
    draft();
    const ciFix = view.ciFix && "attempts" in view.ciFix ? view.ciFix : null;
    const problem = ciFix ? ciFixProblem(ciFix.attempts) : null;
    if (problem) {
      view.error = problem;
      paint();
      return;
    }
    if (
      view.data.sessionDone === "settled" &&
      (!Number.isInteger(view.data.sessionQuietMinutes ?? 10) ||
        (view.data.sessionQuietMinutes ?? 10) < 1 ||
        (view.data.sessionQuietMinutes ?? 10) > 120)
    ) {
      view.error = "Quiet for, minutes must be a whole number from 1 to 120.";
      paint();
      return;
    }
    const started = generation;
    const { githubQueue, githubQueueError, upToDateRule, riskGate, hotFiles } = view.data;
    void request("Saving merging settings…", async () => {
      if (ciFix && ciFix.attempts !== ciFix.stored) {
        const agents = await settingsRequest<AgentSettings>(engine!, "GET");
        const saved = await settingsRequest<AgentSettings>(
          engine!,
          "PUT",
          { ...agents, merge: { ciFixAttempts: ciFix.attempts } },
          readCsrfToken(document),
        );
        if (started !== generation) return;
        const stored = storedCiFix(saved);
        view.ciFix = { attempts: stored, stored };
      }
      const data = await mergeSettingsRequest(
        engine!,
        "PUT",
        mergeSettingsBody(view.data!),
        readCsrfToken(document),
      );
      if (started !== generation) return;
      view.data = {
        ...data,
        ...(githubQueue === undefined ? {} : { githubQueue }),
        ...(githubQueueError ? { githubQueueError } : {}),
        ...(upToDateRule ? { upToDateRule } : {}),
        ...(riskGate ? { riskGate } : {}),
        ...(hotFiles ? { hotFiles } : {}),
      };
      view.saved = true;
    });
  };
  const change = (event: Event) => {
    if (view.busy) return;
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    // A High-risk paths box changes on blur; repainting then would swallow the click that blurred
    // it, such as Save. Submit and the other buttons read it.
    if (target.name === "merge-ci-fix-attempts" || target.name === "session-quiet") return;
    if (/^(risk|ignore-bots|ignore-markers)-/.test(target.name)) return;
    draft();
    paint();
  };
  return {
    mount(next, nextEngine) {
      if (root === next && engine === nextEngine) return;
      root?.removeEventListener("click", click);
      root?.removeEventListener("submit", submit);
      root?.removeEventListener("change", change);
      if (engine !== nextEngine) {
        generation += 1;
        view = { data: null, busy: null, error: null, saved: false };
      }
      root = next;
      engine = nextEngine;
      root.addEventListener("click", click);
      root.addEventListener("submit", submit);
      root.addEventListener("change", change);
      if (!engine) {
        view.error = "Connect to your Paws dashboard to edit merging settings.";
        paint();
      } else if (!view.data && !view.busy && !view.denied) void load();
      else paint();
    },
  };
}
