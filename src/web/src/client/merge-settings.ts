import { journalCaught } from "../journal";
import { renderMarkup } from "./theme";
import type {
  CommentWait,
  HighRiskRepository,
  HotFile,
  MainMoved,
  MergeChoice,
  MergeOrder,
  MergeSettings,
  MergeSettingsView,
} from "../merge-settings";
import { esc } from "./format";
import { readCsrfToken } from "./csrf";

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
  saved: boolean;
  denied?: boolean;
  projectDraft?: string;
  ruleProjectDraft?: string;
  ruleLabelDraft?: string;
};

function projectName(data: MergeSettingsView, id: string): string {
  return data.choices?.projects.find((project) => project.id === id)?.name ?? id;
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

/** Both selects for one level. `inherited` shows the choice it inherits, disabled. */
function choiceFields(
  scope: string,
  choice: MergeChoice,
  inherited: boolean | null,
  repos: { queues: readonly string[]; upToDate: readonly string[] },
  inheritLabel = "Use workspace default",
): string {
  const disabled = inherited ? "disabled" : "";
  return `${inherited === null ? "" : `<label class="settings-inherit"><input type="checkbox" name="${scope}-inherit" ${inherited ? "checked" : ""}>${inheritLabel}</label>`}
    <div class="settings-controls"><div class="settings-field"><label for="${scope}-order">Merge order</label><select id="${scope}-order" name="${scope}-order" aria-describedby="${scope}-order-help" ${disabled}>${options(orderNames(repos.queues, choice.order), choice.order)}</select><small class="sub" id="${scope}-order-help">${esc(orderHelp(choice.order, repos.queues))}</small></div>
    <div class="settings-field"><label for="${scope}-main">When main moved before the merge</label><select id="${scope}-main" name="${scope}-main" aria-describedby="${scope}-main-help" ${disabled}>${options(MAIN_MOVED, choice.mainMoved)}</select><small class="sub" id="${scope}-main-help">${esc(mainMovedHelp(choice.mainMoved, repos.upToDate))}</small></div></div>`;
}

function effective(override: Partial<MergeChoice> | undefined, fallback: MergeChoice): MergeChoice {
  return {
    order: override?.order ?? fallback.order,
    mainMoved: override?.mainMoved ?? fallback.mainMoved,
  };
}

function overrides(value: Partial<MergeChoice>): boolean {
  return value.order !== undefined || value.mainMoved !== undefined;
}

/** The globs in a High-risk paths box: one per line, blank lines dropped. */
export function riskGlobs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
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

export function renderMergeSettings(view: View): string {
  if (view.denied) return '<p class="sub">Only workspace admins can change merging settings.</p>';
  const intro = '<p class="sub">An item keeps the settings it had when it started.</p>';
  if (!view.data)
    return `${intro}<div class="settings-message" role="${view.error ? "alert" : "status"}">${esc(view.error ?? "Loading merging settings…")}</div>${view.error ? '<button class="btn" type="button" data-merge="reload">Try again</button>' : ""}`;
  const data = view.data;
  const repos = { queues: data.githubQueue?.repositories ?? [], upToDate: data.upToDateRule ?? [] };
  const feedback = view.error
    ? `<p class="settings-message err" role="alert">${esc(view.error)}</p>`
    : view.saved
      ? '<p class="settings-message" role="status">Merging settings saved. Items that start from now on use them.</p>'
      : "";
  const choices = data.choices;
  const listed = new Set(data.projects.map((project) => project.id));
  const available = choices?.projects.filter((project) => !listed.has(project.id)) ?? [];
  const projectPicker = choices
    ? `<select id="merge-new-project" name="new-project"><option value="">Choose a Linear project</option>${available.map((project) => `<option value="${esc(project.id)}" ${project.id === view.projectDraft ? "selected" : ""}>${esc(project.name)}</option>`).join("")}</select>`
    : `<input id="merge-new-project" name="new-project" value="${esc(view.projectDraft ?? "")}" placeholder="Linear project id" autocapitalize="none" spellcheck="false">`;
  const ruleProject = `<select id="merge-rule-project" name="rule-project" aria-label="Project"><option value="">Any project</option>${(choices?.projects ?? data.projects.map((project) => ({ id: project.id, name: project.id }))).map((project) => `<option value="${esc(project.id)}" ${project.id === view.ruleProjectDraft ? "selected" : ""}>${esc(project.name)}</option>`).join("")}</select>`;
  const ruleLabel = choices
    ? `<select id="merge-rule-label" name="rule-label" aria-label="Label"><option value="">Label</option>${choices.labels.map((label) => `<option value="${esc(label)}" ${label === view.ruleLabelDraft ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>`
    : `<input id="merge-rule-label" name="rule-label" aria-label="Label" value="${esc(view.ruleLabelDraft ?? "")}" placeholder="Linear label">`;
  return `${intro}${data.githubQueueError ? `<p class="settings-message" role="status">${esc(data.githubQueueError)}</p>` : ""}${data.choicesError ? `<p class="settings-message err" role="status">${esc(data.choicesError)} Enter a project id or label by hand, or <button class="btn" type="button" data-merge="reload">reload</button>.</p>` : ""}<form id="merge-settings-form"><div id="merge-feedback">${feedback}</div>
    <fieldset class="settings-fields" ${view.busy ? "disabled" : ""}>
      <section class="settings-section"><div class="settings-label"><h2>Workspace default</h2><p class="sub">Used by every project unless a project or an issue rule says otherwise.</p></div><div class="col">${choiceFields("default", data.default, null, repos)}</div></section>
      <section class="settings-section"><div class="settings-label"><h2>Projects</h2><p class="sub">Override the default for one Linear project.</p></div><div class="col">
      ${
        data.projects.length
          ? data.projects
              .map(
                (project, index) =>
                  `<section class="settings-project"><div class="between"><h3>${esc(projectName(data, project.id))}</h3><button class="btn" type="button" data-merge="remove-project" data-index="${index}" aria-label="Remove ${esc(projectName(data, project.id))}">Remove</button></div>${choiceFields(`project-${index}`, effective(project, data.default), !overrides(project), repos)}</section>`,
              )
              .join("")
          : '<p class="sub">No project overrides.</p>'
      }
      <div class="settings-add"><label for="merge-new-project">Project</label>${projectPicker}<div class="row"><button class="btn" type="button" data-merge="add-project">Add project</button></div></div></div></section>
      <section class="settings-section"><div class="settings-label"><h2>Issue rules</h2><p class="sub">A rule matches a Linear label in a project, or in any project, and wins over the project setting. The labels are read when an item starts.</p></div><div class="col">
      ${
        data.rules.length
          ? data.rules
              .map((rule, index) => {
                const project = data.projects.find((entry) => entry.id === rule.project);
                const title = `${rule.project === undefined ? "Any project" : projectName(data, rule.project)} · label ${rule.label}`;
                return `<section class="settings-project"><div class="between"><h3>${esc(title)}</h3><button class="btn" type="button" data-merge="remove-rule" data-index="${index}" aria-label="Remove ${esc(title)}">Remove</button></div>${choiceFields(`rule-${index}`, effective(rule, effective(project, data.default)), !overrides(rule), repos, "Use the project or workspace setting")}</section>`;
              })
              .join("")
          : '<p class="sub">No issue rules.</p>'
      }
      <div class="settings-add"><label for="merge-rule-project">New rule</label>${ruleProject}${ruleLabel}<div class="row"><button class="btn" type="button" data-merge="add-rule">Add rule</button></div></div></div></section>
      ${data.commentWait ? commentWaitSection(data.commentWait) : ""}
      ${riskGateSection(data.riskGate)}
      ${data.highRiskRepositories ? riskSection(data.highRiskRepositories) : ""}
      ${data.hotFiles ? hotFileSection(data.hotFiles) : ""}
      <div class="settings-actions"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-merge="reload">Discard changes</button></div>
    </fieldset>${view.busy ? `<p class="settings-message" role="status">${esc(view.busy)}</p>` : ""}</form>`;
}

/** Read-only: the files that caused merge-queue conflicts in the last 7 days. */
function hotFileSection(files: readonly HotFile[]): string {
  const body = files.length
    ? `<ul class="risk-file">${files
        .map(
          (file) =>
            `<li><code>${esc(file.path)}</code> <span class="sub">${esc(file.repository)} · ${file.conflicts} ${file.conflicts === 1 ? "conflict" : "conflicts"} (${esc(file.items.join(", "))})</span></li>`,
        )
        .join("")}</ul>`
    : '<p class="sub">No merge-queue conflicts in the last 7 days.</p>';
  return `<section class="settings-section" id="merge-hot-files"><div class="settings-label"><h2>Conflict-prone files</h2><p class="sub">Files that sent work back for a merge-queue conflict in the last 7 days. A queued item that changes one of them waits while a running or merge-queue item changes it too, until that one merges. Read-only.</p></div><div class="col">${body}</div></section>`;
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
    default: data.default,
    projects: data.projects,
    rules: data.rules,
    ...(data.commentWait ? { commentWait: data.commentWait } : {}),
    ...(data.highRiskRepositories
      ? {
          highRiskPaths: data.highRiskRepositories.map((entry) => ({
            repository: entry.repository,
            paths: entry.paths,
          })),
        }
      : {}),
  };
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
    throw new Error(
      typeof data.error === "string" ? data.error : `Request failed (${response.status}).`,
      { cause: response.status },
    );
  return data as MergeSettingsView;
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
    data.projects = data.projects.map((project, index) => {
      const scope = `project-${index}`;
      if (form.querySelector<HTMLInputElement>(`[name="${scope}-inherit"]`)?.checked)
        return { id: project.id };
      return { id: project.id, ...read(scope, effective(project, data.default)) };
    });
    data.rules = data.rules.map((rule, index) => {
      const scope = `rule-${index}`;
      const base = {
        ...(rule.project === undefined ? {} : { project: rule.project }),
        label: rule.label,
      };
      if (form.querySelector<HTMLInputElement>(`[name="${scope}-inherit"]`)?.checked) return base;
      const project = data.projects.find((entry) => entry.id === rule.project);
      return { ...base, ...read(scope, effective(rule, effective(project, data.default))) };
    });
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
    view.projectDraft = value("new-project")?.trim() ?? "";
    view.ruleProjectDraft = value("rule-project") ?? "";
    view.ruleLabelDraft = value("rule-label")?.trim() ?? "";
    view.saved = false;
    view.error = null;
  };
  const request = async (busy: string, operation: () => Promise<void>) => {
    const started = generation;
    view.busy = busy;
    view.error = null;
    try {
      paint();
      await operation();
    } catch (error) {
      journalCaught(error, "merge-settings.createMergeSettings.paint", null);
      if (started === generation)
        view.error = error instanceof Error ? error.message : "Could not update merging settings.";
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
        const data = await mergeSettingsRequest(engine!, "GET");
        if (started !== generation) return;
        view = { data, busy: view.busy, error: null, saved: false };
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
    const action = button.dataset.merge;
    if (action === "reload") {
      void load();
      return;
    }
    draft();
    const data = view.data;
    if (!data) return;
    const index = Number(button.dataset.index);
    if (action === "remove-project") data.projects.splice(index, 1);
    if (action === "remove-rule") data.rules.splice(index, 1);
    if (action === "add-project") {
      const id = view.projectDraft ?? "";
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(id)) view.error = "Choose a Linear project.";
      else if (data.projects.some((project) => project.id === id))
        view.error = "This project is already listed.";
      else {
        data.projects.push({ id });
        view.projectDraft = "";
      }
    }
    if (action === "add-rule") {
      const label = view.ruleLabelDraft ?? "";
      const project = view.ruleProjectDraft || undefined;
      if (!label) view.error = "Choose a Linear label for the rule.";
      else if (
        data.rules.some(
          (rule) => rule.project === project && rule.label.toLowerCase() === label.toLowerCase(),
        )
      )
        view.error = "This rule already exists.";
      else {
        data.rules.push({ ...(project === undefined ? {} : { project }), label });
        view.ruleLabelDraft = "";
      }
    }
    paint();
  };
  const submit = (event: Event) => {
    event.preventDefault();
    if (view.busy || !view.data || !engine) return;
    draft();
    const started = generation;
    const choices = view.data.choices;
    const choicesError = view.data.choicesError;
    const { githubQueue, githubQueueError, upToDateRule, riskGate, hotFiles } = view.data;
    void request("Saving merging settings…", async () => {
      const data = await mergeSettingsRequest(
        engine!,
        "PUT",
        mergeSettingsBody(view.data!),
        readCsrfToken(document),
      );
      if (started !== generation) return;
      view.data = {
        ...data,
        choices,
        ...(choicesError ? { choicesError } : {}),
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
    if (["new-project", "rule-project", "rule-label"].includes(target.name)) return;
    if (target.name.startsWith("risk-")) return;
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
