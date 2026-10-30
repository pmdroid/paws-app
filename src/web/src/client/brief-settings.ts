import { esc } from "./format";
import { readCsrfToken } from "./csrf";
import { renderMarkup } from "./theme";

type Settings = {
  template: string | null;
  defaultTemplate: string;
  placeholders: string[];
  projects: { repo: string; template: string | null }[];
};
type Preview = { text: string; total: number; sections: { name: string; characters: number }[] };

export function createBriefSettings() {
  let root: HTMLElement | null = null;
  let engine: string | null = null;
  let data: Settings | null = null;
  let scope = "";
  let repository = "";
  let identifier = "";
  let template = "";
  let error = "";
  let message = "";
  let preview: Preview | null = null;
  let busy = false;
  let generation = 0;
  const effective = () =>
    scope
      ? (data?.projects.find((p) => p.repo === scope)?.template ??
        data?.template ??
        data?.defaultTemplate ??
        "")
      : (data?.template ?? data?.defaultTemplate ?? "");
  const paint = () => {
    if (!root) return;
    if (!data) {
      renderMarkup(
        root,
        `<section class="settings-section"><p role="${error ? "alert" : "status"}">${esc(error || "Loading brief settings…")}</p></section>`,
      );
      return;
    }
    const options = data.projects
      .map(
        (p) =>
          `<option value="${esc(p.repo)}" ${p.repo === scope ? "selected" : ""}>${esc(p.repo)}</option>`,
      )
      .join("");
    const repositories = data.projects
      .map(
        (p) =>
          `<option value="${esc(p.repo)}" ${p.repo === repository ? "selected" : ""}>${esc(p.repo)}</option>`,
      )
      .join("");
    renderMarkup(
      root,
      `<section class="settings-section"><div class="settings-label"><h2>Agent brief</h2><p class="sub">Edit the instructions given to the coding agent. Repository templates override the workspace template.</p></div><div class="col">
      <label>Template scope <select name="brief-scope"><option value="">Workspace</option>${options}</select></label>
      <label for="brief-template">Template</label><textarea id="brief-template" name="brief-template" rows="18">${esc(template)}</textarea>
      <small class="sub">Placeholders: ${data.placeholders.map((p) => esc(`{{${p}}}`)).join(", ")}</small>
      <div class="row"><button class="btn" data-brief="save" ${busy ? "disabled" : ""}>Save</button><button class="btn" data-brief="reset" ${busy ? "disabled" : ""}>Reset to default</button></div>
      <h3>Preview</h3><p class="sub">Run-only sections use marked samples.</p><label>Repository <select name="brief-repository"><option value="">Choose a repository</option>${repositories}</select></label><label>Linear issue identifier <input name="brief-identifier" value="${esc(identifier)}" placeholder="PAS-864"></label><div><button class="btn" data-brief="preview" ${busy ? "disabled" : ""}>Preview</button></div>
      ${error ? `<p role="alert" class="err">${esc(error)}</p>` : message ? `<p role="status">${esc(message)}</p>` : ""}
      ${preview ? `<p>Total: ${preview.total} characters</p><ul>${preview.sections.map((s) => `<li>${esc(s.name)}: ${s.characters} characters</li>`).join("")}</ul><pre>${esc(preview.text)}</pre>` : ""}</div></section>`,
    );
  };
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(new URL(path, engine!), {
      method,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(body !== undefined
          ? { "Content-Type": "application/json", "x-paws-csrf": readCsrfToken(document) }
          : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
    return result;
  };
  const run = async (action: string) => {
    if (!engine || busy) return;
    const started = generation;
    busy = true;
    error = "";
    message = "";
    paint();
    try {
      if (action === "load") {
        data = await request("/api/settings/brief");
        template = effective();
      } else if (action === "preview") {
        preview = await request("/api/settings/brief/preview", "POST", {
          template,
          repository,
          identifier,
        });
      } else {
        data = await request("/api/settings/brief", "PUT", {
          repo: scope || null,
          template: action === "reset" ? null : template,
        });
        template = effective();
        preview = null;
        message = action === "reset" ? "Template reset." : "Template saved.";
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not load brief settings.";
    }
    if (started !== generation) return;
    busy = false;
    paint();
  };
  const input = (event: Event) => {
    const target = event.target as HTMLInputElement;
    if (target.name === "brief-template") template = target.value;
    if (target.name === "brief-identifier") identifier = target.value;
  };
  const change = (event: Event) => {
    const target = event.target as HTMLSelectElement;
    if (target.name === "brief-scope") {
      scope = target.value;
      template = effective();
      preview = null;
      error = "";
      paint();
    } else if (target.name === "brief-repository") repository = target.value;
  };
  const click = (event: Event) => {
    const action = (event.target as Element).closest<HTMLElement>("[data-brief]")?.dataset.brief;
    if (action) void run(action);
  };
  return {
    mount(next: HTMLElement, nextEngine: string | null) {
      if (root === next && engine === nextEngine) return;
      root?.removeEventListener("input", input);
      root?.removeEventListener("change", change);
      root?.removeEventListener("click", click);
      if (engine !== nextEngine) {
        generation++;
        data = null;
        busy = false;
      }
      root = next;
      engine = nextEngine;
      root.addEventListener("input", input);
      root.addEventListener("change", change);
      root.addEventListener("click", click);
      if (!engine) {
        error = "Connect to your Paws dashboard to manage brief settings.";
        paint();
      } else if (!data) void run("load");
      else paint();
    },
  };
}
