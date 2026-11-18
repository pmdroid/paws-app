import { journalCaught } from "../journal";
import type { AgentSettings } from "../agent-settings";
import { settingsRequest } from "./agent-settings";
import { readCsrfToken } from "./csrf";
import { esc } from "./format";
import { renderMarkup } from "./theme";

export type ProjectMemorySettings = NonNullable<AgentSettings["projectMemory"]>;
export type ProjectMemoryView = {
  memory: ProjectMemorySettings | null;
  busy: string | null;
  error: string | null;
  saved: boolean;
  denied?: boolean;
};

const SWITCHES: Array<[keyof ProjectMemorySettings, string, string]> = [
  [
    "decisions",
    "Save answers as decisions",
    "When a person answers an agent's question, Paws saves the question and answer as a project decision.",
  ],
  [
    "workSummary",
    "Summarize finished work",
    "When Paws opens a pull request, it saves a short summary of the change to the project's memory.",
  ],
  [
    "dream",
    "Dream",
    "Once a day, when a project has enough new entries, a model merges its memory into a few topics. Uses an agent account and costs tokens.",
  ],
];

export function renderProjectMemorySettings(view: ProjectMemoryView): string {
  if (view.denied) return "";
  if (!view.memory)
    return `<section class="settings-section"><div class="col"><div class="settings-message" role="${view.error ? "alert" : "status"}">${esc(view.error ?? "Loading project memory settings…")}</div>${view.error ? '<div class="row"><button class="btn" type="button" data-project-memory="reload">Try again</button></div>' : ""}</div></section>`;
  const memory = view.memory;
  const feedback = view.error
    ? `<p class="settings-message err" role="alert">${esc(view.error)}</p>`
    : view.busy
      ? `<p class="settings-message" role="status">${esc(view.busy)}</p>`
      : view.saved
        ? '<p class="settings-message" role="status">Saved.</p>'
        : "";
  const switches = SWITCHES.map(
    ([key, label, help]) =>
      `<label class="settings-inherit"><input type="checkbox" role="switch" name="${key}" ${memory[key] ? "checked" : ""} aria-describedby="project-memory-${key}-help"><span class="min-w-0 flex-1">${label}</span></label><p class="sub" id="project-memory-${key}-help">${esc(help)}</p>`,
  ).join("");
  return `<section class="settings-section"><form id="project-memory-form" class="col">${switches}<p class="sub">With all off, agents see only titles of what's stored and read details with recall when they need them.</p>${feedback}<div class="row"><button class="btn" type="submit" ${view.busy ? "disabled" : ""}>Save project memory settings</button></div></form></section>`;
}

export function createProjectMemorySettings(onSaved: () => void = () => {}): {
  mount(root: HTMLElement, engine: string | null): void;
} {
  let root: HTMLElement | null = null;
  let engine: string | null = null;
  let generation = 0;
  const fresh = (): ProjectMemoryView => ({ memory: null, busy: null, error: null, saved: false });
  let view = fresh();
  const paint = () => {
    if (root) renderMarkup(root, renderProjectMemorySettings(view));
  };
  const read = (settings: AgentSettings): ProjectMemorySettings => ({
    workSummary: settings.projectMemory?.workSummary ?? false,
    dream: settings.projectMemory?.dream ?? false,
    decisions: settings.projectMemory?.decisions ?? false,
  });
  const run = async (busy: string, memory?: ProjectMemorySettings) => {
    if (!engine) return;
    const started = generation;
    Object.assign(view, { busy, error: null, saved: false });
    paint();
    try {
      let settings = await settingsRequest<AgentSettings>(engine, "GET");
      if (memory) {
        const { merge: _merge, ...agents } = settings;
        settings = await settingsRequest<AgentSettings>(
          engine,
          "PUT",
          { ...agents, projectMemory: memory },
          readCsrfToken(document),
        );
        onSaved();
      }
      if (started !== generation) return;
      Object.assign(view, { memory: read(settings), denied: false, saved: memory !== undefined });
    } catch (error) {
      journalCaught(error, "project-memory-settings.createProjectMemorySettings.request", null);
      if (started !== generation) return;
      if (error instanceof Error && error.cause === 403 && !memory) view.denied = true;
      else
        view.error =
          error instanceof Error ? error.message : "Could not save project memory settings.";
    }
    view.busy = null;
    paint();
  };
  const change = (event: Event) => {
    const field = event.target as HTMLInputElement;
    if (!view.memory || !field.closest("#project-memory-form")) return;
    const key = SWITCHES.find(([name]) => name === field.name)?.[0];
    if (key) view.memory = { ...view.memory, [key]: field.checked };
    view.saved = false;
    view.error = null;
  };
  const click = (event: Event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-project-memory]");
    if (button?.dataset.projectMemory === "reload" && !view.busy)
      void run("Loading project memory settings…");
  };
  const submit = (event: Event) => {
    if ((event.target as Element).id !== "project-memory-form") return;
    event.preventDefault();
    if (!view.memory || view.busy) return;
    void run("Saving project memory settings…", view.memory);
  };
  return {
    mount(next, nextEngine) {
      if (root === next && engine === nextEngine) return;
      root?.removeEventListener("click", click);
      root?.removeEventListener("change", change);
      root?.removeEventListener("submit", submit);
      if (engine !== nextEngine) {
        generation += 1;
        view = fresh();
      }
      root = next;
      engine = nextEngine;
      root.addEventListener("click", click);
      root.addEventListener("change", change);
      root.addEventListener("submit", submit);
      if (!engine) {
        view.error = "Connect to your Paws dashboard to manage project memory settings.";
        paint();
      } else if (!view.memory && !view.busy && !view.denied)
        void run("Loading project memory settings…");
      else paint();
    },
  };
}
