import { renderMarkup } from "./theme";
import { esc } from "./format";
import { readCsrfToken } from "./github-auth";

export type SkillAgent = "claude" | "codex" | "grok";

export type SkillPin = {
  name: string;
  source:
    | { kind: "npm"; package: string; subfolder?: string }
    | { kind: "git"; url: string; ref?: string; subfolder?: string }
    | { kind: "upload"; folder: string };
  version: string;
  sha256: string;
  sizeBytes: number;
  agents: SkillAgent[];
  removedAt: number | null;
};

/** How many runners that are not revoked have a skill's pinned bundle, and which ones lag. */
export type SkillRollout = {
  name: string;
  total: number;
  upToDate: number;
  installing: string[];
  outOfDate: string[];
  failed: string[];
};

export type SkillListing = {
  skills: SkillPin[];
  /** Older Paws releases leave it out. */
  rollouts?: SkillRollout[];
  agents: SkillAgent[];
  limitBytes: number;
  notice?: string;
};

type SkillDraft = { source: string; ref: string; subfolder: string; agents: SkillAgent[] };

export type SkillView = {
  data: SkillListing | null;
  busy: string | null;
  error: string | null;
  notice: string | null;
  denied?: boolean;
  draft?: SkillDraft;
};

const AGENT_NAMES: Record<SkillAgent, string> = { claude: "Claude", codex: "Codex", grok: "Grok" };
const ALL_AGENTS: SkillAgent[] = ["claude", "codex", "grok"];
const PATH = "/api/settings/skills";

const intro =
  '<div class="settings-label"><h2>Skills</h2><p class="sub">Installed for every agent on every runner before each run. Versions are pinned until you update them.</p></div>';

/** An npm package (optionally `name@version`) or a git URL, read from the one source field. */
export function parseSkillSource(
  text: string,
  ref = "",
  subfolder = "",
): Record<string, string> | null {
  const value = text.trim();
  if (!value) return null;
  const folder: Record<string, string> = subfolder.trim() ? { subfolder: subfolder.trim() } : {};
  if (/^(?:https?|ssh|git|file):\/\/|^[\w.-]+@[\w.-]+:|^\/|\.git$/.test(value))
    return {
      kind: "git",
      url: value,
      ...(ref.trim() ? { ref: ref.trim() } : {}),
      ...folder,
    };
  if (/^(?:github\.com|gitlab\.com|bitbucket\.org)\//.test(value))
    return {
      kind: "git",
      url: `https://${value}`,
      ...(ref.trim() ? { ref: ref.trim() } : {}),
      ...folder,
    };
  const at = value.lastIndexOf("@");
  return at > 0
    ? { kind: "npm", package: value.slice(0, at), version: value.slice(at + 1), ...folder }
    : { kind: "npm", package: value, ...folder };
}

export function skillSourceLabel(skill: SkillPin): string {
  const source = skill.source;
  const where =
    source.kind === "npm"
      ? `npm ${source.package}`
      : source.kind === "git"
        ? `${source.url.replace(/^https?:\/\//, "").replace(/\.git$/, "")}${source.ref ? `#${source.ref}` : ""}`
        : `Uploaded ${source.folder}`;
  const folder = source.kind !== "upload" && source.subfolder ? ` /${source.subfolder}` : "";
  return `${where}${folder}`;
}

function shortVersion(skill: SkillPin): string {
  return skill.source.kind === "git" ? skill.version.slice(0, 7) : skill.version;
}

function runnerNames(names: readonly string[], state: string): string {
  return names.length <= 2 ? `${names.join(", ")} ${state}` : `${names.length} runners ${state}`;
}

/** "2 of 2 up to date", then one badge per runner state that lags behind the pin. */
export function skillRolloutMarkup(rollout: SkillRollout | undefined): string {
  if (!rollout) return "";
  if (rollout.total === 0)
    return '<div class="skill-runners"><span class="tag">No runners yet</span></div>';
  const behind = [
    rollout.failed.length
      ? `<span class="tag bad wrap">${esc(runnerNames(rollout.failed, "failed"))}</span>`
      : "",
    rollout.installing.length
      ? `<span class="tag running wrap">${esc(runnerNames(rollout.installing, "installing"))}</span>`
      : "",
    rollout.outOfDate.length
      ? `<span class="tag warn wrap">${esc(runnerNames(rollout.outOfDate, "out of date"))}</span>`
      : "",
  ].join("");
  return `<div class="skill-runners"><span class="tag">${rollout.upToDate} of ${rollout.total} up to date</span>${behind}</div>`;
}

function skillRow(skill: SkillPin, busy: boolean, rollout?: SkillRollout): string {
  const name = esc(skill.name);
  const removed = skill.removedAt !== null;
  const actions = removed
    ? ""
    : `<div class="skill-actions">${skill.source.kind === "upload" ? "" : `<button class="btn" type="button" data-skill="update" data-name="${name}" ${busy ? "disabled" : ""} aria-label="Update ${name}">Update</button>`}<button class="btn" type="button" data-skill="remove" data-name="${name}" ${busy ? "disabled" : ""} aria-label="Remove ${name}">Remove</button></div>`;
  return `<tr><td class="skill-cell"><div class="skill-name"><b>${name}</b><span>${esc(shortVersion(skill))}</span>${removed ? '<span class="tag warn">Removing from runners</span>' : ""}</div><p class="sub">${esc(skillSourceLabel(skill))} · ${skill.agents.map((agent) => AGENT_NAMES[agent]).join(", ")}</p><p class="mono" title="SHA-256 ${esc(skill.sha256)}">sha256 ${esc(skill.sha256.slice(0, 12))}</p></td><td class="skill-state">${removed ? "" : skillRolloutMarkup(rollout)}${actions}</td></tr>`;
}

export function renderSkillSettings(view: SkillView): string {
  if (view.denied)
    return `<section class="settings-section">${intro}<p class="sub">Only workspace owners and admins can change skills.</p></section>`;
  if (!view.data)
    return `<section class="settings-section">${intro}<div class="col"><div class="settings-message" role="${view.error ? "alert" : "status"}">${esc(view.error ?? "Loading skills…")}</div>${view.error ? '<div class="row"><button class="btn" type="button" data-skill="reload">Try again</button></div>' : ""}</div></section>`;
  const draft = view.draft ?? { source: "", ref: "", subfolder: "", agents: view.data.agents };
  const busy = view.busy !== null;
  const table = view.data.skills.length
    ? `<table class="skills-table"><thead><tr><th>Skill</th><th class="skill-state">Runners</th></tr></thead><tbody>${view.data.skills
        .map((skill) =>
          skillRow(
            skill,
            busy,
            view.data!.rollouts?.find((rollout) => rollout.name === skill.name),
          ),
        )
        .join("")}</tbody></table>`
    : '<p class="settings-message">No skills yet. Agents only load what is in their own home and the repository.</p>';
  const feedback = view.error
    ? `<p class="settings-message err" role="alert">${esc(view.error)}</p>`
    : view.busy
      ? `<p class="settings-message" role="status">${esc(view.busy)}</p>`
      : view.notice
        ? `<p class="settings-message" role="status">${esc(view.notice)}</p>`
        : "";
  const megabytes = Math.round(view.data.limitBytes / (1024 * 1024));
  return `<section class="settings-section">${intro}<div class="col">${table}${feedback}
    <form id="skill-add-form" class="col"><fieldset class="settings-fields" ${busy ? "disabled" : ""}>
      <div class="settings-field"><label for="skill-source">Add a skill</label><input id="skill-source" name="skill-source" value="${esc(draft.source)}" placeholder="npm package, git URL, or upload a folder" autocapitalize="none" spellcheck="false" aria-describedby="skill-source-help"><small class="sub" id="skill-source-help">Paws pins the exact package version or commit. Each skill needs a SKILL.md and stays under ${megabytes} MB.</small></div>
      <details class="skill-options"><summary>Git ref and subfolder</summary><div class="settings-controls"><div class="settings-field"><label for="skill-ref">Git ref</label><input id="skill-ref" name="skill-ref" value="${esc(draft.ref)}" placeholder="main, v1.2.0, or a commit" autocapitalize="none" spellcheck="false"></div><div class="settings-field"><label for="skill-subfolder">Subfolder</label><input id="skill-subfolder" name="skill-subfolder" value="${esc(draft.subfolder)}" placeholder="skills/review" autocapitalize="none" spellcheck="false"></div></div></details>
      <div class="settings-field"><span class="sub">Agents</span><div class="row">${view.data.agents.map((agent) => `<label class="settings-inherit"><input type="checkbox" name="skill-agent" value="${agent}" ${draft.agents.includes(agent) ? "checked" : ""}>${AGENT_NAMES[agent]}</label>`).join("")}</div></div>
      <div class="row"><button class="btn primary" type="submit">Add skill</button></div>
      <div class="settings-field"><label for="skill-upload">Or upload a folder</label><input id="skill-upload" name="skill-upload" type="file" webkitdirectory="" multiple></div>
    </fieldset></form></div></section>`;
}

async function skillRequest(
  engine: string,
  init: { method: "GET" } | { method: "POST"; body: unknown },
): Promise<SkillListing> {
  const upload = init.method === "POST" && init.body instanceof FormData;
  const response = await fetch(new URL(PATH, engine), {
    method: init.method,
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(init.method === "POST" ? { "x-paws-csrf": readCsrfToken(document) } : {}),
      ...(init.method === "POST" && !upload ? { "Content-Type": "application/json" } : {}),
    },
    ...(init.method === "POST"
      ? { body: upload ? (init.body as FormData) : JSON.stringify(init.body) }
      : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      typeof data.error === "string" ? data.error : `Request failed (${response.status}).`,
      { cause: response.status },
    );
  return data as SkillListing;
}

export function createSkillSettings(): {
  mount(root: HTMLElement, engine: string | null): void;
} {
  let root: HTMLElement | null = null;
  let engine: string | null = null;
  let generation = 0;
  let view: SkillView = { data: null, busy: null, error: null, notice: null };
  const paint = () => {
    if (root) renderMarkup(root, renderSkillSettings(view));
  };
  const readDraft = (): SkillDraft | undefined => {
    const form = root?.querySelector<HTMLFormElement>("#skill-add-form");
    if (!form) return view.draft;
    const field = (name: string) =>
      form.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value ?? "";
    return {
      source: field("skill-source"),
      ref: field("skill-ref"),
      subfolder: field("skill-subfolder"),
      agents: [...form.querySelectorAll<HTMLInputElement>('[name="skill-agent"]:checked')].map(
        (input) => input.value as SkillAgent,
      ),
    };
  };
  const run = async (busy: string, body: unknown, reset = false) => {
    if (!engine) return;
    const started = generation;
    view.draft = readDraft();
    view.busy = busy;
    view.error = null;
    view.notice = null;
    paint();
    try {
      const data = await skillRequest(
        engine,
        body === undefined ? { method: "GET" } : { method: "POST", body },
      );
      if (started !== generation) return;
      view.data = data;
      view.denied = false;
      view.notice = data.notice ?? null;
      if (reset) view.draft = undefined;
    } catch (error) {
      if (started !== generation) return;
      if (error instanceof Error && error.cause === 403 && body === undefined) view.denied = true;
      else view.error = error instanceof Error ? error.message : "Could not change skills.";
    }
    view.busy = null;
    paint();
  };
  const click = (event: Event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-skill]");
    if (!button || view.busy) return;
    const name = button.dataset.name ?? "";
    if (button.dataset.skill === "reload") void run("Loading skills…", undefined);
    if (button.dataset.skill === "update")
      void run(`Resolving the newest version of ${name}…`, { action: "update", name });
    if (button.dataset.skill === "remove" && confirm(`Remove ${name} from every runner?`))
      void run(`Removing ${name}…`, { action: "remove", name });
  };
  const submit = (event: Event) => {
    event.preventDefault();
    if (view.busy) return;
    const draft = readDraft();
    const source = draft && parseSkillSource(draft.source, draft.ref, draft.subfolder);
    if (!draft || !source || draft.agents.length === 0) {
      view.draft = draft;
      view.error = !source
        ? "Enter an npm package or a git URL, or upload a folder."
        : "Choose at least one agent for this skill.";
      paint();
      return;
    }
    void run(
      `Fetching ${draft.source.trim()}…`,
      { action: "add", source, agents: draft.agents },
      true,
    );
  };
  const change = (event: Event) => {
    const input = event.target as HTMLInputElement;
    if (input.name !== "skill-upload" || !input.files?.length || view.busy) return;
    const files = [...input.files];
    // Browsers prefix every path with the chosen folder's name; the skill starts inside it.
    const folder = files[0]!.webkitRelativePath.split("/")[0] || "skill";
    const form = new FormData();
    form.append("folder", folder);
    for (const agent of readDraft()?.agents ?? ALL_AGENTS) form.append("agents", agent);
    for (const file of files) {
      form.append("path", file.webkitRelativePath.split("/").slice(1).join("/") || file.name);
      form.append("file", file);
    }
    input.value = "";
    void run(`Uploading ${folder}…`, form, true);
  };
  return {
    mount(next, nextEngine) {
      if (root === next && engine === nextEngine) return;
      root?.removeEventListener("click", click);
      root?.removeEventListener("submit", submit);
      root?.removeEventListener("change", change);
      if (engine !== nextEngine) {
        generation += 1;
        view = { data: null, busy: null, error: null, notice: null };
      }
      root = next;
      engine = nextEngine;
      root.addEventListener("click", click);
      root.addEventListener("submit", submit);
      root.addEventListener("change", change);
      if (!engine) {
        view.error = "Connect to your Paws dashboard to manage skills.";
        paint();
      } else if (!view.data && !view.busy && !view.denied) void run("Loading skills…", undefined);
      else paint();
    },
  };
}
