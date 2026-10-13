import type { AgentConnection, AgentProfile, AgentRole, AgentSettings } from "../agent-settings";
import { esc } from "./format";
import { readCsrfToken } from "./github-auth";

const ROLES: AgentRole[] = ["implementer", "reviewer"];
const AGENTS = { claude: "Claude Code", codex: "Codex", grok: "Grok" };

export function settingsProblems(settings: AgentSettings): string[] {
  const profiles = [
    { name: "Global defaults", ...settings.defaults },
    ...settings.projects.map((project) => ({
      name: project.repo,
      implementer: project.implementer ?? settings.defaults.implementer,
      reviewer: project.reviewer ?? settings.defaults.reviewer,
    })),
  ];
  return profiles
    .filter(
      ({ implementer, reviewer }) =>
        implementer.agent === reviewer.agent && implementer.model === reviewer.model,
    )
    .map(
      ({ name }) => `${name}: choose a different reviewer agent or model for independent review.`,
    );
}

export async function settingsRequest<T>(
  engine: string,
  method: "GET" | "PUT" | "POST",
  body?: unknown,
  csrf = "",
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const path = method === "POST" ? "/api/settings/agents/test" : "/api/settings/agents";
  const response = await fetchImpl(new URL(path, engine), {
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
  return data as T;
}

type SettingsView = {
  data: AgentSettings | null;
  busy: string | null;
  error: string | null;
  saved: boolean;
  connections: Map<string, AgentConnection>;
  denied?: boolean;
};

export function renderAgentSettings(view: SettingsView): string {
  if (view.denied) return "<h1>Settings</h1>";
  const intro = `<h1>Agent settings</h1><p class="sub">Choose who implements and independently reviews new work. Agents use their own CLI sign-ins on this machine.</p>`;
  if (!view.data)
    return `${intro}<div class="settings-message" role="${view.error ? "alert" : "status"}">${esc(view.error ?? "Loading agent settings…")}</div>${view.error ? '<button class="btn" type="button" data-settings="reload">Try again</button>' : ""}`;
  const problems = settingsProblems(view.data);
  const feedback = view.error
    ? `<p class="settings-message err" role="alert">${esc(view.error)}</p>`
    : view.saved
      ? '<p class="settings-message" role="status">Agent settings saved. New work will use these profiles.</p>'
      : "";
  return `${intro}<form id="agent-settings-form"><div id="settings-feedback">${feedback}</div>
    <fieldset class="settings-fields" ${view.busy ? "disabled" : ""}>
      <section class="settings-section"><div class="settings-label"><h2>Global defaults</h2><p class="sub">Used by projects that inherit these roles. The reviewer must use a different agent or model.</p></div><div>${ROLES.map((role) => profileFields("defaults", role, view.data!.defaults[role], null, view.connections)).join("")}</div></section>
      <section class="settings-section"><div class="settings-label"><h2>Project overrides</h2><p class="sub">Set a profile for an individual repository, or inherit its global default.</p></div><div>
      ${view.data.projects.length ? view.data.projects.map((project, index) => `<section class="settings-project"><h3>${esc(project.repo)}</h3>${ROLES.map((role) => profileFields(String(index), role, project[role] ?? view.data!.defaults[role], project[role] === undefined, view.connections)).join("")}</section>`).join("") : '<p class="sub">No project overrides.</p>'}
      <div class="settings-add"><label for="settings-repo">Repository</label><div class="row"><input id="settings-repo" name="repo" placeholder="owner/repository" autocapitalize="none" spellcheck="false"><button class="btn" type="button" data-settings="add">Add project</button></div></div></div></section>
      <div id="settings-problems" class="settings-message err" role="alert" ${problems.length ? "" : "hidden"}>${problems.map(esc).join("<br>")}</div>
      <div class="settings-actions"><button class="btn primary" type="submit" ${problems.length ? "disabled" : ""}>Save settings</button><button class="btn" type="button" data-settings="reload">Discard changes</button></div>
    </fieldset>${view.busy ? `<p class="settings-message" role="status">${esc(view.busy)}</p>` : ""}</form>`;
}

function profileFields(
  scope: string,
  role: AgentRole,
  profile: AgentProfile,
  inherited: boolean | null,
  connections: SettingsView["connections"],
): string {
  const key = `${scope}-${role}`;
  const connection = connections.get(key);
  const disabled = inherited ? "disabled" : "";
  const label = role === "implementer" ? "Implementer" : "Reviewer";
  const efforts = connection?.efforts ?? [];
  const effortChoices =
    profile.effort && !efforts.some((effort) => effort.id === profile.effort)
      ? [{ id: profile.effort, name: profile.effort }, ...efforts]
      : efforts;
  const effortHelp = !connection
    ? "Test connection to load effort choices for this model."
    : connection.ok && !efforts.length
      ? "This model uses its agent's default effort."
      : "";
  return `<div class="settings-profile"><div class="settings-role"><h3>${label}</h3>${inherited !== null ? `<label class="settings-inherit"><input type="checkbox" name="${key}-inherit" ${inherited ? "checked" : ""}>Use global default</label>` : ""}</div>
    <div class="settings-controls"><div class="settings-field"><label for="${key}-agent">Agent</label><select id="${key}-agent" name="${key}-agent" ${disabled}>${Object.entries(
      AGENTS,
    )
      .map(
        ([id, name]) =>
          `<option value="${id}" ${id === profile.agent ? "selected" : ""}>${name}</option>`,
      )
      .join("")}</select></div>
    <div class="settings-field"><label for="${key}-model">Model</label><input id="${key}-model" name="${key}-model" value="${esc(profile.model ?? "")}" placeholder="Agent default" list="${key}-models" autocapitalize="none" spellcheck="false" ${disabled}><datalist id="${key}-models">${(connection?.models ?? []).map((model) => `<option value="${esc(model.id)}">${esc(model.name)}</option>`).join("")}</datalist></div>
    <div class="settings-field"><label for="${key}-effort">Effort</label><select id="${key}-effort" name="${key}-effort" aria-describedby="${key}-effort-help" ${inherited || !effortChoices.length ? "disabled" : ""}><option value="" ${profile.effort ? "" : "selected"}>Agent default</option>${effortChoices.map((effort) => `<option value="${esc(effort.id)}" ${effort.id === profile.effort ? "selected" : ""}>${esc(effort.name)}</option>`).join("")}</select></div>
    <button class="btn" type="button" data-settings="test" data-profile="${key}">Test connection</button></div>
    <p id="${key}-effort-help" class="sub" ${effortHelp ? "" : "hidden"}>${effortHelp}</p>
    ${connection ? `<p data-connection="${key}" class="settings-message ${connection.ok ? "" : "err"}" role="status">${esc(connection.message)}${connection.ok && connection.model ? ` Model: ${esc(connection.model)}.` : ""}</p>` : ""}</div>`;
}

export function createAgentSettings(invalidate: () => void): {
  mount(root: HTMLElement, engine: string | null): void;
} {
  let root: HTMLElement | null = null;
  let engine: string | null = null;
  let generation = 0;
  let view: SettingsView = {
    data: null,
    busy: null,
    error: null,
    saved: false,
    connections: new Map(),
  };
  const paint = () => {
    if (!root) return;
    let heldFocus: string | null = null;
    const active = document.activeElement;
    if (active instanceof HTMLElement && root.contains(active)) {
      heldFocus = active.id
        ? `#${CSS.escape(active.id)}`
        : active.getAttribute("name")
          ? `[name="${active.getAttribute("name")}"]`
          : active.dataset.profile
            ? `[data-profile="${active.dataset.profile}"]`
            : active.dataset.settings
              ? `[data-settings="${active.dataset.settings}"]`
              : null;
    }
    root.innerHTML = renderAgentSettings(view);
    if (heldFocus) root.querySelector<HTMLElement>(heldFocus)?.focus({ preventScroll: true });
  };
  const draft = () => {
    if (!root || !view.data) return;
    const form = root.querySelector("form");
    if (!form) return;
    const read = (key: string, previous: AgentProfile): AgentProfile => ({
      agent: (form.querySelector<HTMLSelectElement>(`[name="${key}-agent"]`)?.value ??
        previous.agent) as AgentProfile["agent"],
      model: form.querySelector<HTMLInputElement>(`[name="${key}-model"]`)?.value.trim() || null,
      ...(form.querySelector<HTMLSelectElement>(`[name="${key}-effort"]`)?.value
        ? { effort: form.querySelector<HTMLSelectElement>(`[name="${key}-effort"]`)!.value }
        : {}),
    });
    for (const role of ROLES)
      view.data.defaults[role] = read(`defaults-${role}`, view.data.defaults[role]);
    view.data.projects.forEach((project, index) => {
      for (const role of ROLES) {
        const key = `${index}-${role}`;
        if (form.querySelector<HTMLInputElement>(`[name="${key}-inherit"]`)?.checked)
          delete project[role];
        else project[role] = read(key, project[role] ?? view.data!.defaults[role]);
      }
    });
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
        view.error = error instanceof Error ? error.message : "Could not update agent settings.";
    } finally {
      if (started === generation) {
        view.busy = null;
        paint();
        invalidate();
      }
    }
  };
  const load = () =>
    request("Loading agent settings…", async () => {
      const started = generation;
      let data: AgentSettings;
      try {
        data = await settingsRequest<AgentSettings>(engine!, "GET");
      } catch (error) {
        if (started === generation && error instanceof Error && error.cause === 403) {
          view.denied = true;
          view.data = null;
          view.error = null;
          view.connections.clear();
          return;
        }
        throw error;
      }
      if (started !== generation) return;
      view.denied = false;
      view.data = data;
      view.saved = false;
      view.connections.clear();
    });
  const click = (event: Event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-settings]");
    if (!button || view.busy || !engine) return;
    const action = button.dataset.settings;
    if (action === "reload") {
      void load();
      return;
    }
    draft();
    if (action === "add" && view.data) {
      const input = root?.querySelector<HTMLInputElement>("#settings-repo");
      const repo = input?.value.trim().toLowerCase() ?? "";
      if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo))
        view.error = "Enter a repository as owner/repository.";
      else if (view.data.projects.some((project) => project.repo === repo))
        view.error = "This project is already listed.";
      else view.data.projects.push({ repo });
      paint();
    }
    if (action === "test" && view.data) {
      const key = button.dataset.profile!;
      const [scope, role] = key.split("-") as [string, AgentRole];
      const profile =
        scope === "defaults"
          ? view.data.defaults[role]
          : (view.data.projects[Number(scope)]?.[role] ?? view.data.defaults[role]);
      const started = generation;
      void request(`Testing ${AGENTS[profile.agent]} connection…`, async () => {
        const result = await settingsRequest<AgentConnection>(
          engine!,
          "POST",
          { profile },
          readCsrfToken(document),
        );
        if (started === generation) view.connections.set(key, result);
      });
    }
  };
  const submit = (event: Event) => {
    event.preventDefault();
    if (view.busy || !view.data || !engine) return;
    draft();
    const problems = settingsProblems(view.data);
    if (problems.length) {
      view.error = problems.join(" ");
      paint();
      return;
    }
    const started = generation;
    void request("Saving agent settings…", async () => {
      const data = await settingsRequest<AgentSettings>(
        engine!,
        "PUT",
        view.data,
        readCsrfToken(document),
      );
      if (started !== generation) return;
      view.data = data;
      view.saved = true;
    });
  };
  const change = (event: Event) => {
    if (view.busy) return;
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    draft();
    const name = target.name;
    root?.querySelector("#settings-feedback")?.replaceChildren();
    if (name.endsWith("-agent") || name.endsWith("-model")) {
      const key = name.replace(/-(agent|model)$/, "");
      view.connections.delete(key);
      root?.querySelector(`[data-connection="${key}"]`)?.remove();
      const [scope, role] = key.split("-") as [string, AgentRole];
      const profile =
        scope === "defaults"
          ? view.data?.defaults[role]
          : view.data?.projects[Number(scope)]?.[role];
      if (profile) delete profile.effort;
      const effort = root?.querySelector<HTMLSelectElement>(`[name="${key}-effort"]`);
      if (effort) {
        effort.innerHTML = '<option value="">Agent default</option>';
        effort.disabled = true;
      }
      const help = root?.querySelector<HTMLElement>(`#${CSS.escape(`${key}-effort-help`)}`);
      if (help) {
        help.textContent = "Test connection to load effort choices for this model.";
        help.hidden = false;
      }
    }
    if (target instanceof HTMLInputElement && target.type !== "checkbox") {
      const problems = view.data ? settingsProblems(view.data) : [];
      const holder = root?.querySelector<HTMLElement>("#settings-problems");
      if (holder) {
        holder.innerHTML = problems.map(esc).join("<br>");
        holder.hidden = problems.length === 0;
      }
      const save = root?.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (save) save.disabled = problems.length > 0;
      return;
    }
    paint();
    root?.querySelector<HTMLElement>(`[name="${name}"]`)?.focus();
  };
  return {
    mount(next, nextEngine) {
      if (root === next && engine === nextEngine) return;
      root?.removeEventListener("click", click);
      root?.removeEventListener("submit", submit);
      root?.removeEventListener("change", change);
      root?.removeEventListener("input", change);
      const sourceChanged = engine !== nextEngine;
      root = next;
      engine = nextEngine;
      if (sourceChanged) {
        generation += 1;
        view = { data: null, busy: null, error: null, saved: false, connections: new Map() };
      }
      root.addEventListener("click", click);
      root.addEventListener("submit", submit);
      root.addEventListener("change", change);
      root.addEventListener("input", change);
      if (!engine) {
        view.error = "Connect to your local Paws engine to edit agent settings.";
        paint();
        const button = root.querySelector<HTMLButtonElement>('[data-settings="reload"]');
        if (button) {
          button.removeAttribute("data-settings");
          button.dataset.action = "source";
          button.textContent = "Connect engine";
        }
      } else if (!view.data && !view.busy && !view.denied) void load();
      else paint();
    },
  };
}
