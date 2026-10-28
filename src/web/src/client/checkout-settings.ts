import { renderMarkup } from "./theme";
import type {
  CheckoutHideFrom,
  CheckoutPath,
  CheckoutRepository,
  CheckoutSettings,
  CheckoutSettingsUpdate,
} from "../checkout-settings";
import { esc } from "./format";
import { readCsrfToken } from "./csrf";

const PATH = "/api/settings/checkout";
const FULL_CHECKOUT_LABEL = "paws:full-checkout";
const HIDE_FROM: Record<CheckoutHideFrom, string> = {
  agent: "Hidden from the agent",
  checks: "Hidden from agent and checks",
};

export type CheckoutView = {
  /** The last loaded or saved settings. */
  saved: CheckoutSettings | null;
  /** The repositories as edited on the page. */
  draft: CheckoutRepository[];
  busy: string | null;
  error: string | null;
  notice: string | null;
  warnings: string[];
  denied?: boolean;
  /** Text typed in each repository's add field, by repository. */
  adding: Record<string, string>;
  /** The add field's validation message, by repository. */
  addErrors: Record<string, string>;
};

export function emptyCheckoutView(): CheckoutView {
  return {
    saved: null,
    draft: [],
    busy: null,
    error: null,
    notice: null,
    warnings: [],
    adding: {},
    addErrors: {},
  };
}

/** A view showing `settings` as loaded, with nothing changed. */
export function loadedCheckoutView(settings: CheckoutSettings): CheckoutView {
  return { ...emptyCheckoutView(), saved: settings, draft: cloneRepositories(settings) };
}

function cloneRepositories(settings: CheckoutSettings): CheckoutRepository[] {
  return settings.repositories.map((repository) => ({
    ...repository,
    paths: repository.paths.map((path) => ({ ...path, usedBy: [...path.usedBy] })),
  }));
}

function pathKey(paths: readonly CheckoutPath[]): string {
  return JSON.stringify(paths.map(({ path, hideFrom }) => [path, hideFrom]));
}

function repositoryChanged(view: CheckoutView, repository: CheckoutRepository): boolean {
  const saved = view.saved?.repositories.find((entry) => entry.repo === repository.repo);
  return !saved || pathKey(saved.paths) !== pathKey(repository.paths);
}

export function checkoutChanged(view: CheckoutView): boolean {
  if (!view.saved) return false;
  if (view.saved.repositories.length !== view.draft.length) return true;
  return view.draft.some((repository) => repositoryChanged(view, repository));
}

/** The PUT body: every repository with its paths and where each is hidden. */
export function checkoutSettingsBody(
  repositories: readonly CheckoutRepository[],
): CheckoutSettingsUpdate {
  return {
    repositories: repositories.map((repository) => ({
      repo: repository.repo,
      paths: repository.paths.map(({ path, hideFrom }) => ({ path, hideFrom })),
    })),
  };
}

/** Why `input` cannot be added to a repository that already lists `existing`, or null. */
export function checkoutPathProblem(input: string, existing: readonly string[]): string | null {
  const path = input.trim();
  if (!path) return "Enter a path or glob.";
  if (path.includes("\\")) return "Use forward slashes in the path.";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.startsWith("~"))
    return "Enter a path relative to the repository root.";
  const segments = (path.endsWith("/") ? path.slice(0, -1) : path).split("/");
  if (segments.some((segment) => segment === ""))
    return "Remove the empty part of the path between slashes.";
  if (segments.some((segment) => segment === "." || segment === ".."))
    return 'A path cannot use "." or ".." as a folder.';
  if (segments.some((segment) => segment === ".git")) return "The .git folder cannot be left out.";
  if (existing.includes(path)) return "This path is already listed.";
  return null;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

function repositoryBadge(view: CheckoutView, repository: CheckoutRepository): string {
  const paths = repository.paths.length;
  if (paths === 0) return '<span class="tag">Nothing left out</span>';
  if (repository.files && !repositoryChanged(view, repository))
    return `<span class="tag">Agent sees ${count(repository.files.agent)} of ${count(repository.files.total)} files</span>`;
  return `<span class="tag">${paths === 1 ? "1 path" : `${count(paths)} paths`} left out</span>`;
}

function checkList(ids: readonly string[]): string {
  return ids.map((id) => `<b>${esc(id)}</b>`).join(", ");
}

function usedByNote(path: CheckoutPath): string {
  if (path.usedBy.length === 0) return "";
  const several = path.usedBy.length > 1;
  const read = `${esc(path.path)} is read by the Closeout ${several ? "checks" : "check"} ${checkList(path.usedBy)}.`;
  return path.hideFrom === "checks"
    ? `<p class="checkout-note warn" role="note">${read} Hiding it from checks can make ${several ? "those checks" : "that check"} fail.</p>`
    : `<p class="checkout-note" role="note">${read} It stays visible to checks while it is hidden from the agent only.</p>`;
}

function pathRow(repo: number, index: number, path: CheckoutPath, disabled: string): string {
  const id = `checkout-${repo}-${index}`;
  const used = path.usedBy.length
    ? `<span class="tag warn wrap">Used by ${path.usedBy.length > 1 ? "checks" : "check"}: ${esc(path.usedBy.join(", "))}</span>`
    : "";
  return `<li class="checkout-path"><div class="checkout-path-row"><div class="checkout-path-name"><span class="checkout-path-text">${esc(path.path)}</span>${used}</div><select id="${id}-hide" name="checkout-hide" data-repo="${repo}" data-index="${index}" aria-label="Where ${esc(path.path)} is hidden" ${disabled}>${(
    Object.entries(HIDE_FROM) as [CheckoutHideFrom, string][]
  )
    .map(
      ([value, name]) =>
        `<option value="${value}" ${value === path.hideFrom ? "selected" : ""}>${esc(name)}</option>`,
    )
    .join(
      "",
    )}</select><button class="btn" type="button" data-checkout="remove" data-repo="${repo}" data-index="${index}" aria-label="Remove ${esc(path.path)}" ${disabled}>Remove</button></div>${usedByNote(path)}</li>`;
}

function repositoryCard(view: CheckoutView, repository: CheckoutRepository, repo: number): string {
  const disabled = view.busy ? "disabled" : "";
  const inputId = `checkout-add-${repo}`;
  const problem = view.addErrors[repository.repo];
  const paths = repository.paths.length
    ? `<ul class="checkout-paths">${repository.paths.map((path, index) => pathRow(repo, index, path, disabled)).join("")}</ul>`
    : "";
  return `<section class="card checkout-repo" aria-label="${esc(repository.repo)}"><div class="checkout-repo-body"><div class="between"><h3>${esc(repository.repo)}</h3>${repositoryBadge(view, repository)}</div>${paths}
    <form class="checkout-add" data-repo="${repo}"><label for="${inputId}">Add a path or glob</label><div class="checkout-add-row"><input id="${inputId}" name="checkout-add" data-repo="${repo}" value="${esc(view.adding[repository.repo] ?? "")}" placeholder="docs/plans/  or  **/*.generated.ts" autocapitalize="none" autocomplete="off" spellcheck="false" ${problem ? `aria-invalid="true" aria-describedby="${inputId}-error"` : ""} ${disabled}><button class="btn" type="submit" ${disabled}>Add path</button></div>${problem ? `<p class="checkout-error" id="${inputId}-error" role="alert">${esc(problem)}</p>` : ""}</form></div></section>`;
}

export function renderCheckoutSettings(view: CheckoutView): string {
  const label = view.saved?.label ?? FULL_CHECKOUT_LABEL;
  const intro = `<div class="settings-label"><h2>Repository checkout</h2><p class="sub">Leave paths out of the checkout so agents only see what helps them. New runs use the change; a running item keeps the checkout it started with. Add the Linear label <code>${esc(label)}</code> to an issue to run it with everything.</p></div>`;
  if (view.denied)
    return `<section class="settings-section">${intro}<p class="sub">Only workspace admins can change the repository checkout.</p></section>`;
  if (!view.saved)
    return `<section class="settings-section">${intro}<div class="col"><div class="settings-message" role="${view.error ? "alert" : "status"}">${esc(view.error ?? "Loading repository checkout…")}</div>${view.error ? '<div class="row"><button class="btn" type="button" data-checkout="reload">Try again</button></div>' : ""}</div></section>`;
  const changed = checkoutChanged(view);
  const unchanged = !changed || view.busy ? "disabled" : "";
  const cards = view.draft.length
    ? view.draft.map((repository, index) => repositoryCard(view, repository, index)).join("")
    : '<p class="settings-message">No repositories yet. Connect a repository to choose what its checkout leaves out.</p>';
  const feedback = view.error
    ? `<p class="settings-message err" role="alert">${esc(view.error)}</p>`
    : view.busy
      ? `<p class="settings-message" role="status">${esc(view.busy)}</p>`
      : view.notice
        ? `<p class="settings-message" role="status">${esc(view.notice)}</p>`
        : "";
  const warnings = view.warnings.length
    ? `<div class="checkout-note warn" role="alert">${view.warnings.map((warning) => `<p>${esc(warning)}</p>`).join("")}</div>`
    : "";
  return `<section class="settings-section">${intro}<div class="col">${cards}${warnings}${feedback}${
    view.draft.length
      ? `<div class="settings-actions"><button class="btn primary" type="button" data-checkout="save" ${unchanged}>Save</button><button class="btn" type="button" data-checkout="discard" ${unchanged}>Discard changes</button></div>`
      : ""
  }</div></section>`;
}

export async function checkoutSettingsRequest(
  engine: string,
  method: "GET" | "PUT",
  body?: CheckoutSettingsUpdate,
  csrf = "",
  fetchImpl: typeof fetch = fetch,
): Promise<CheckoutSettings> {
  const response = await fetchImpl(new URL(PATH, engine), {
    method,
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(method === "GET" ? {} : { "Content-Type": "application/json", "x-paws-csrf": csrf }),
    },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      typeof data.error === "string" ? data.error : `Request failed (${response.status}).`,
      { cause: response.status },
    );
  return data as CheckoutSettings;
}

/** Adds the typed path to repository `repo`, or records why it cannot be added. */
export function addCheckoutPath(view: CheckoutView, repo: number, input: string): boolean {
  const repository = view.draft[repo];
  if (!repository) return false;
  const problem = checkoutPathProblem(
    input,
    repository.paths.map((path) => path.path),
  );
  view.notice = null;
  if (problem) {
    view.adding[repository.repo] = input;
    view.addErrors[repository.repo] = problem;
    return false;
  }
  repository.paths.push({ path: input.trim(), hideFrom: "agent", usedBy: [] });
  view.adding[repository.repo] = "";
  delete view.addErrors[repository.repo];
  return true;
}

export function setCheckoutHideFrom(
  view: CheckoutView,
  repo: number,
  index: number,
  hideFrom: CheckoutHideFrom,
): void {
  const path = view.draft[repo]?.paths[index];
  if (!path || !(hideFrom in HIDE_FROM)) return;
  path.hideFrom = hideFrom;
  view.notice = null;
}

export function removeCheckoutPath(view: CheckoutView, repo: number, index: number): void {
  view.draft[repo]?.paths.splice(index, 1);
  view.notice = null;
}

export function createCheckoutSettings(): {
  mount(root: HTMLElement, engine: string | null): void;
} {
  let root: HTMLElement | null = null;
  let engine: string | null = null;
  let generation = 0;
  let view = emptyCheckoutView();
  /** Keeps what was typed in each add field across a repaint. */
  const capture = () => {
    for (const input of root?.querySelectorAll<HTMLInputElement>('[name="checkout-add"]') ?? []) {
      const repository = view.draft[Number(input.dataset.repo)];
      if (repository) view.adding[repository.repo] = input.value;
    }
  };
  const paint = () => {
    if (!root) return;
    const active = document.activeElement;
    const held =
      active instanceof HTMLElement && root.contains(active) && active.id ? active.id : "";
    renderMarkup(root, renderCheckoutSettings(view));
    if (held)
      root.querySelector<HTMLElement>(`#${CSS.escape(held)}`)?.focus({ preventScroll: true });
  };
  const request = async (busy: string, body?: CheckoutSettingsUpdate) => {
    if (!engine) return;
    const started = generation;
    capture();
    view.busy = busy;
    view.error = null;
    view.notice = null;
    if (body) view.warnings = [];
    paint();
    try {
      const data = await checkoutSettingsRequest(
        engine,
        body ? "PUT" : "GET",
        body,
        body ? readCsrfToken(document) : "",
      );
      if (started !== generation) return;
      const adding = view.adding;
      view = loadedCheckoutView(data);
      view.adding = adding;
      if (body) {
        view.notice = "Saved.";
        view.warnings = (data.warnings ?? []).filter((warning) => typeof warning === "string");
      }
    } catch (error) {
      if (started !== generation) return;
      if (error instanceof Error && error.cause === 403 && !body) view.denied = true;
      else
        view.error =
          error instanceof Error ? error.message : "Could not change the repository checkout.";
    }
    view.busy = null;
    paint();
  };
  const click = (event: Event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-checkout]");
    if (!button || view.busy) return;
    const action = button.dataset.checkout;
    const repo = Number(button.dataset.repo);
    const index = Number(button.dataset.index);
    if (action === "reload") void request("Loading repository checkout…");
    if (action === "save" && view.saved && checkoutChanged(view))
      void request("Saving repository checkout…", checkoutSettingsBody(view.draft));
    if (action === "discard" && view.saved) {
      capture();
      const adding = view.adding;
      view = loadedCheckoutView(view.saved);
      view.adding = adding;
      paint();
    }
    if (action === "remove") {
      capture();
      removeCheckoutPath(view, repo, index);
      view.error = null;
      paint();
    }
  };
  const submit = (event: Event) => {
    const form = (event.target as Element).closest<HTMLFormElement>("form.checkout-add");
    if (!form) return;
    event.preventDefault();
    if (view.busy) return;
    capture();
    const repo = Number(form.dataset.repo);
    const input = form.querySelector<HTMLInputElement>('[name="checkout-add"]');
    view.error = null;
    addCheckoutPath(view, repo, input?.value ?? "");
    paint();
    if (!view.addErrors[view.draft[repo]?.repo ?? ""])
      root?.querySelector<HTMLInputElement>(`#checkout-add-${repo}`)?.focus();
  };
  const change = (event: Event) => {
    const target = event.target as HTMLSelectElement;
    if (view.busy || target.name !== "checkout-hide") return;
    capture();
    setCheckoutHideFrom(
      view,
      Number(target.dataset.repo),
      Number(target.dataset.index),
      target.value as CheckoutHideFrom,
    );
    view.error = null;
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
        view = emptyCheckoutView();
      }
      root = next;
      engine = nextEngine;
      root.addEventListener("click", click);
      root.addEventListener("submit", submit);
      root.addEventListener("change", change);
      if (!engine) {
        view.error = "Connect to your Paws dashboard to change the repository checkout.";
        paint();
      } else if (!view.saved && !view.busy && !view.denied)
        void request("Loading repository checkout…");
      else paint();
    },
  };
}
