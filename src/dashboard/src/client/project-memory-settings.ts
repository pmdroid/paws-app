import { journalCaught } from "../journal";
import type { AgentSettings } from "../agent-settings";
import { settingsRequest } from "./agent-settings";
import { readCsrfToken } from "./csrf";
import { esc } from "./format";
import { renderMarkup } from "./theme";

type Memory = NonNullable<AgentSettings["projectMemory"]>;
type View = { memory: Memory | null; busy: boolean; error: string | null; saved: boolean };

const SWITCHES: Array<[keyof Memory, string, string]> = [
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

export function renderProjectMemorySettings(view: View): string {
  const message = view.error
    ? `<p class="settings-message err" role="alert">${esc(view.error)}</p>`
    : view.busy || !view.memory
      ? '<p class="settings-message" role="status">Loading project memory settings…</p>'
      : view.saved
        ? '<p class="settings-message" role="status">Saved.</p>'
        : "";
  if (!view.memory) return `<section class="settings-section">${message}</section>`;
  const memory = view.memory;
  const switches = SWITCHES.map(
    ([key, label, help]) =>
      `<label class="settings-inherit"><input type="checkbox" role="switch" name="${key}" ${memory[key] ? "checked" : ""} aria-describedby="project-memory-${key}-help"><span class="min-w-0 flex-1">${label}</span></label><p class="sub" id="project-memory-${key}-help">${esc(help)}</p>`,
  ).join("");
  return `<section class="settings-section"><form id="project-memory-form" class="col">${switches}<p class="sub">With all off, agents see only titles of what's stored and read details with recall when they need them.</p>${message}<div class="row"><button class="btn" type="submit" ${view.busy ? "disabled" : ""}>Save project memory settings</button></div></form></section>`;
}

export function createProjectMemorySettings(onSaved: () => void = () => {}): {
  mount(root: HTMLElement, engine: string | null): void;
} {
  let root: HTMLElement | null = null;
  let engine: string | null = null;
  let view: View = { memory: null, busy: false, error: null, saved: false };
  const paint = () => {
    if (root) renderMarkup(root, renderProjectMemorySettings(view));
  };
  const run = async (memory?: Memory) => {
    if (!engine) return;
    const current = engine;
    Object.assign(view, { busy: true, error: null, saved: false });
    paint();
    try {
      let settings = await settingsRequest<AgentSettings>(current, "GET");
      if (memory) {
        const { merge: _merge, ...agents } = settings;
        const body = { ...agents, projectMemory: memory };
        settings = await settingsRequest(current, "PUT", body, readCsrfToken(document));
        onSaved();
      }
      if (current !== engine) return;
      view.memory = {
        workSummary: false,
        dream: false,
        decisions: false,
        ...settings.projectMemory,
      };
      view.saved = memory !== undefined;
    } catch (error) {
      journalCaught(error, "project-memory-settings.createProjectMemorySettings.request", null);
      if (current !== engine) return;
      view.error = error instanceof Error ? error.message : "Could not save.";
    }
    view.busy = false;
    paint();
  };
  const change = (event: Event) => {
    const field = event.target as HTMLInputElement;
    const key = SWITCHES.find(([name]) => name === field.name)?.[0];
    if (!view.memory || !key || !field.closest("#project-memory-form")) return;
    view = { ...view, memory: { ...view.memory, [key]: field.checked }, saved: false, error: null };
  };
  const submit = (event: Event) => {
    if ((event.target as Element).id !== "project-memory-form") return;
    event.preventDefault();
    if (view.memory && !view.busy) void run(view.memory);
  };
  return {
    mount(next, nextEngine) {
      if (root === next && engine === nextEngine) return;
      root?.removeEventListener("change", change);
      root?.removeEventListener("submit", submit);
      if (engine !== nextEngine) view = { memory: null, busy: false, error: null, saved: false };
      root = next;
      engine = nextEngine;
      root.addEventListener("change", change);
      root.addEventListener("submit", submit);
      if (!engine) {
        view.error = "Connect to your Paws dashboard to manage project memory settings.";
        paint();
      } else if (!view.memory && !view.busy) void run();
      else paint();
    },
  };
}
