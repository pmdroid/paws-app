import { renderMarkup } from "./theme";
import type {
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

export function renderMergeSettings(view: View): string {
  if (view.denied)
    return '<p class="sub">Only workspace owners and admins can change merging settings.</p>';
  const intro = '<p class="sub">A task keeps the settings it had when it started.</p>';
  if (!view.data)
    return `${intro}<div class="settings-message" role="${view.error ? "alert" : "status"}">${esc(view.error ?? "Loading merging settings…")}</div>${view.error ? '<button class="btn" type="button" data-merge="reload">Try again</button>' : ""}`;
  const data = view.data;
  const repos = { queues: data.githubQueue?.repositories ?? [], upToDate: data.upToDateRule ?? [] };
  const feedback = view.error
    ? `<p class="settings-message err" role="alert">${esc(view.error)}</p>`
    : view.saved
      ? '<p class="settings-message" role="status">Merging settings saved. Tasks that start from now on use them.</p>'
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
      <section class="settings-section"><div class="settings-label"><h2>Issue rules</h2><p class="sub">A rule matches a Linear label in a project, or in any project, and wins over the project setting. The labels are read when a task starts.</p></div><div class="col">
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
      <div class="settings-actions"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-merge="reload">Discard changes</button></div>
    </fieldset>${view.busy ? `<p class="settings-message" role="status">${esc(view.busy)}</p>` : ""}</form>`;
}

/** The saved body: the page's settings without the Linear choices. */
export function mergeSettingsBody(data: MergeSettingsView): MergeSettings {
  return { default: data.default, projects: data.projects, rules: data.rules };
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
    const { githubQueue, githubQueueError, upToDateRule } = view.data;
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
      };
      view.saved = true;
    });
  };
  const change = (event: Event) => {
    if (view.busy) return;
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    if (["new-project", "rule-project", "rule-label"].includes(target.name)) return;
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
