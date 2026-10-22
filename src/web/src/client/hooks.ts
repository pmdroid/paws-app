import { renderMarkup } from "./theme";
import { esc } from "./format";
import { readCsrfToken } from "./github-auth";

export type HookAgent = "claude" | "codex";
export type HookEvent = "after_edit" | "before_shell" | "before_tool" | "stop";

export type WorkspaceHook = {
  id: string;
  event: HookEvent;
  matcher: string | null;
  command: string;
  timeoutSeconds: number;
  agents: HookAgent[];
  skill: string | null;
};

export type HookListing = {
  hooks: WorkspaceHook[];
  events: { id: HookEvent; label: string }[];
  agents: HookAgent[];
  skills: { name: string; agents: string[] }[];
  limit: number;
  notice?: string;
};

type HookDraft = {
  event: HookEvent;
  matcher: string;
  command: string;
  timeout: string;
  skill: string;
  agents: HookAgent[];
};

export type HookView = {
  data: HookListing | null;
  busy: string | null;
  error: string | null;
  notice: string | null;
  denied?: boolean;
  draft?: HookDraft;
};

const AGENT_NAMES: Record<HookAgent, string> = { claude: "Claude", codex: "Codex" };
const PATH = "/api/settings/hooks";

const intro =
  '<div class="settings-label"><h2>Hooks</h2><p class="sub">Run alongside Paws\'s own Closeout hook. Hooks run as the agent\'s user and never see your secrets.</p></div>';

function hookRow(hook: WorkspaceHook, label: string, busy: boolean): string {
  const details = [
    hook.matcher ? `Tools ${esc(hook.matcher)}` : "",
    hook.skill ? `Skill ${esc(hook.skill)}` : "",
    `${hook.timeoutSeconds}s timeout`,
  ].filter(Boolean);
  return `<tr><td class="skill-cell"><b>${esc(label)}</b><p class="mono">${esc(hook.command)}</p><p class="sub">${details.join(" · ")}</p></td><td class="skill-state"><p class="sub">${hook.agents.map((agent) => AGENT_NAMES[agent]).join(", ")}</p><div class="skill-actions"><button class="btn" type="button" data-hook="remove" data-id="${esc(hook.id)}" ${busy ? "disabled" : ""} aria-label="Remove hook ${esc(hook.command)}">Remove</button></div></td></tr>`;
}

export function renderHookSettings(view: HookView): string {
  if (view.denied)
    return `<section class="settings-section">${intro}<p class="sub">Only workspace owners and admins can change hooks.</p></section>`;
  if (!view.data)
    return `<section class="settings-section">${intro}<div class="col"><div class="settings-message" role="${view.error ? "alert" : "status"}">${esc(view.error ?? "Loading hooks…")}</div>${view.error ? '<div class="row"><button class="btn" type="button" data-hook="reload">Try again</button></div>' : ""}</div></section>`;
  const data = view.data;
  const draft: HookDraft = view.draft ?? {
    event: "after_edit",
    matcher: "",
    command: "",
    timeout: "60",
    skill: "",
    agents: data.agents,
  };
  const busy = view.busy !== null;
  const labels = new Map(data.events.map((event) => [event.id, event.label]));
  const table = data.hooks.length
    ? `<table class="skills-table"><thead><tr><th>Hook</th><th class="skill-state">Agents</th></tr></thead><tbody>${data.hooks.map((hook) => hookRow(hook, labels.get(hook.event) ?? hook.event, busy)).join("")}</tbody></table>`
    : '<p class="settings-message">No hooks yet. Every run still gets Paws\'s Closeout hook.</p>';
  const feedback = view.error
    ? `<p class="settings-message err" role="alert">${esc(view.error)}</p>`
    : view.busy
      ? `<p class="settings-message" role="status">${esc(view.busy)}</p>`
      : view.notice
        ? `<p class="settings-message" role="status">${esc(view.notice)}</p>`
        : "";
  const skills = data.skills.length
    ? `<div class="settings-field"><label for="hook-skill">Script from a skill</label><select id="hook-skill" name="hook-skill"><option value="">No skill</option>${data.skills.map((skill) => `<option value="${esc(skill.name)}" ${draft.skill === skill.name ? "selected" : ""}>${esc(skill.name)}</option>`).join("")}</select><small class="sub">The command runs with $PAWS_SKILL_DIR set to the skill's installed folder.</small></div>`
    : "";
  return `<section class="settings-section">${intro}<div class="col">${table}${feedback}
    <form id="hook-add-form" class="col"><fieldset class="settings-fields" ${busy ? "disabled" : ""}>
      <div class="settings-field"><label for="hook-event">Add a hook</label><select id="hook-event" name="hook-event">${data.events.map((event) => `<option value="${event.id}" ${draft.event === event.id ? "selected" : ""}>${esc(event.label)}</option>`).join("")}</select></div>
      <div class="settings-field"><label for="hook-command">Command</label><input id="hook-command" name="hook-command" value="${esc(draft.command)}" placeholder="Command" autocapitalize="none" spellcheck="false"></div>
      <details class="skill-options"><summary>Tool matcher, timeout and skill</summary><div class="settings-controls"><div class="settings-field"><label for="hook-matcher">Tool matcher</label><input id="hook-matcher" name="hook-matcher" value="${esc(draft.matcher)}" placeholder="Edit|Write" autocapitalize="none" spellcheck="false" aria-describedby="hook-matcher-help"><small class="sub" id="hook-matcher-help">Only for a hook before a tool call. Empty matches every tool.</small></div><div class="settings-field"><label for="hook-timeout">Timeout in seconds</label><input id="hook-timeout" name="hook-timeout" type="number" min="1" max="600" inputmode="numeric" value="${esc(draft.timeout)}"></div>${skills}</div></details>
      <div class="settings-field"><span class="sub">Agents</span><div class="row">${data.agents.map((agent) => `<label class="settings-inherit"><input type="checkbox" name="hook-agent" value="${agent}" ${draft.agents.includes(agent) ? "checked" : ""}>${AGENT_NAMES[agent]}</label>`).join("")}</div></div>
      <div class="row"><button class="btn primary" type="submit">Add hook</button></div>
    </fieldset></form></div></section>`;
}

async function hookRequest(
  engine: string,
  init: { method: "GET" } | { method: "POST"; body: unknown },
): Promise<HookListing> {
  const response = await fetch(new URL(PATH, engine), {
    method: init.method,
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(init.method === "POST"
        ? { "x-paws-csrf": readCsrfToken(document), "Content-Type": "application/json" }
        : {}),
    },
    ...(init.method === "POST" ? { body: JSON.stringify(init.body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      typeof data.error === "string" ? data.error : `Request failed (${response.status}).`,
      { cause: response.status },
    );
  return data as HookListing;
}

export function createHookSettings(): {
  mount(root: HTMLElement, engine: string | null): void;
} {
  let root: HTMLElement | null = null;
  let engine: string | null = null;
  let generation = 0;
  let view: HookView = { data: null, busy: null, error: null, notice: null };
  const paint = () => {
    if (root) renderMarkup(root, renderHookSettings(view));
  };
  const readDraft = (): HookDraft | undefined => {
    const form = root?.querySelector<HTMLFormElement>("#hook-add-form");
    if (!form) return view.draft;
    const field = (name: string) =>
      form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)?.value ?? "";
    return {
      event: (field("hook-event") || "after_edit") as HookEvent,
      matcher: field("hook-matcher"),
      command: field("hook-command"),
      timeout: field("hook-timeout"),
      skill: field("hook-skill"),
      agents: [...form.querySelectorAll<HTMLInputElement>('[name="hook-agent"]:checked')].map(
        (input) => input.value as HookAgent,
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
      const data = await hookRequest(
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
      else view.error = error instanceof Error ? error.message : "Could not change hooks.";
    }
    view.busy = null;
    paint();
  };
  const click = (event: Event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-hook]");
    if (!button || view.busy) return;
    if (button.dataset.hook === "reload") void run("Loading hooks…", undefined);
    if (button.dataset.hook === "remove" && confirm("Remove this hook from every new run?"))
      void run("Removing the hook…", { action: "remove", id: button.dataset.id ?? "" });
  };
  const submit = (event: Event) => {
    event.preventDefault();
    if (view.busy) return;
    const draft = readDraft();
    if (!draft || !draft.command.trim() || draft.agents.length === 0) {
      view.draft = draft;
      view.error = !draft?.command.trim()
        ? "Enter the hook's command."
        : "Choose at least one agent for this hook.";
      paint();
      return;
    }
    void run(
      "Adding the hook…",
      {
        action: "add",
        event: draft.event,
        command: draft.command,
        matcher: draft.matcher,
        timeoutSeconds: draft.timeout,
        skill: draft.skill,
        agents: draft.agents,
      },
      true,
    );
  };
  return {
    mount(next, nextEngine) {
      if (root === next && engine === nextEngine) return;
      root?.removeEventListener("click", click);
      root?.removeEventListener("submit", submit);
      if (engine !== nextEngine) {
        generation += 1;
        view = { data: null, busy: null, error: null, notice: null };
      }
      root = next;
      engine = nextEngine;
      root.addEventListener("click", click);
      root.addEventListener("submit", submit);
      if (!engine) {
        view.error = "Connect to your Paws dashboard to manage hooks.";
        paint();
      } else if (!view.data && !view.busy && !view.denied) void run("Loading hooks…", undefined);
      else paint();
    },
  };
}
