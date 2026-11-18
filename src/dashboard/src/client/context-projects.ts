import { journalCaught } from "../journal";
import type { ContextProject } from "../project-context";
import { esc } from "./format";
import { routeHref } from "./route";
import { renderMarkup } from "./theme";

type Phase = "loading" | "ready" | "error";

export function renderContextProjects(phase: Phase, projects: ContextProject[]): string {
  if (phase === "loading")
    return `<div class="empty" role="status" aria-live="polite">Loading projects…</div>`;
  if (phase === "error")
    return `<div class="empty" role="alert"><div>Could not load projects</div>Paws could not read them just now.<div><button class="btn primary" type="button" data-context-action="retry">Retry</button></div></div>`;
  if (!projects.length)
    return `<div class="empty" role="status">No projects yet. Paws lists a project here once it works on one of its issues.</div>`;
  const rows = projects.map((project) => {
    const href = routeHref({ view: "context", kind: "project", id: project.id });
    const count = `${project.items} ${project.items === 1 ? "issue" : "issues"}`;
    return `<li class="context-record"><div class="row"><a href="${esc(href)}">${esc(project.name ?? "Linear project")}</a><span class="ml-auto muted">${count}</span></div></li>`;
  });
  return `<ul class="improvement-rows" aria-label="Projects">${rows.join("")}</ul>`;
}

export function createContextProjects(options: { fetch?: typeof fetch } = {}) {
  const fetcher = options.fetch ?? fetch;
  let root: HTMLElement | null = null;
  let engine = "";
  let request: AbortController | null = null;
  let shown: { phase: Phase; projects: ContextProject[] } | null = null;
  const paint = (phase: Phase, projects: ContextProject[] = []) => {
    shown = { phase, projects };
    if (root) renderMarkup(root, renderContextProjects(phase, projects));
  };
  const load = async () => {
    request?.abort();
    const controller = (request = new AbortController());
    paint("loading");
    try {
      const response = await fetcher(new URL("/api/context/projects", engine), {
        signal: controller.signal,
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`projects ${response.status}`);
      const body = (await response.json()) as { projects?: ContextProject[] };
      if (controller === request) paint("ready", body.projects ?? []);
    } catch (error) {
      if (controller.signal.aborted) return;
      journalCaught(error, "contextProjects.read", null);
      if (controller === request) paint("error");
    }
  };
  const click = (event: Event) => {
    if ((event.target as Element).closest("[data-context-action=retry]")) void load();
  };
  return {
    mount(next: HTMLElement, nextEngine: string) {
      if (root !== next) {
        root?.removeEventListener("click", click);
        next.addEventListener("click", click);
        root = next;
      }
      if (shown && engine === nextEngine) return paint(shown.phase, shown.projects);
      engine = nextEngine;
      void load();
    },
    leave() {
      request?.abort();
      root?.removeEventListener("click", click);
      root = null;
      shown = null;
    },
  };
}
