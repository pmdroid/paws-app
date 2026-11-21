import { journalCaught } from "../journal";
import { readCsrfToken } from "./csrf";
import { esc } from "./format";
import { renderMarkup } from "./theme";

type Kind = "repository" | "project";
type Summary = { kind: Kind; id: string; name: string; size: number; limit: number };
type Entry = { id: string; body: string; updatedAt: number };
type Change = {
  id: string;
  entryId: string;
  action: "add" | "patch" | "remove";
  before: string | null;
  after: string | null;
  item: string | null;
  actor: string | null;
  at: number;
  undoable: boolean;
};
type Notebook = {
  kind: Kind;
  id: string;
  size: number;
  limit: number;
  entries: Entry[];
  changes: Change[];
};
type Failure = { at: string; text: string };

export type NotebookView = {
  list: Summary[] | null;
  open: Notebook | null;
  busy: boolean;
  editing: string | null;
  removing: string | null;
  drafts: Record<string, string>;
  error: Failure | null;
};

export const NOTEBOOK_EMPTY = "Nothing here yet. Agents add what the next agent should know.";
export const NOTEBOOK_FULL = "This notebook is full. Remove or shorten an entry first.";

const VERBS = { add: "added", patch: "changed", remove: "removed" } as const;

const count = (value: number) => value.toLocaleString("en-US");
const characters = (size: number, limit: number) => `${count(size)} of ${count(limit)} characters`;
const text = (value: string) => esc(value).replaceAll("\n", "<br>");
const when = (at: number) =>
  new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(at);
const pathOf = (kind: Kind, id: string) => `/api/notebooks/${kind}/${encodeURIComponent(id)}`;

export function notebookError(reason: string): string {
  if (/would hold \d+ characters, over its \d+ limit/.test(reason)) return NOTEBOOK_FULL;
  const plain = reason.replace(/^operation \d+: /, "");
  return `${plain.charAt(0).toUpperCase()}${plain.slice(1)}${/[.!?]$/.test(plain) ? "" : "."}`;
}

function failure(view: NotebookView, at: string): string {
  return view.error?.at === at
    ? `<p class="settings-message err" role="alert">${esc(view.error.text)}</p>`
    : "";
}

function renderList(view: NotebookView, list: Summary[]): string {
  if (list.length === 0) return `<p class="empty">${NOTEBOOK_EMPTY}</p>${failure(view, "list")}`;
  const group = (kind: Kind, title: string) => {
    const rows = list.filter((notebook) => notebook.kind === kind);
    if (rows.length === 0) return "";
    const items = rows
      .map(
        (notebook) =>
          `<li class="between"><button class="btn" type="button" data-notebook-open="${esc(`${notebook.kind}:${notebook.id}`)}" ${view.busy ? "disabled" : ""}>${esc(notebook.name)}</button><span class="sub">${characters(notebook.size, notebook.limit)}</span></li>`,
      )
      .join("");
    return `<div class="col"><h2>${title}</h2><ul role="list" aria-label="${title}">${items}</ul></div>`;
  };
  return `${group("repository", "Repositories")}${group("project", "Projects")}${failure(view, "list")}${failure(view, "open")}`;
}

function renderEntry(view: NotebookView, entry: Entry): string {
  const disabled = view.busy ? "disabled" : "";
  if (view.editing === entry.id)
    return `<li><div class="card"><form class="col" data-notebook-form="edit:${esc(entry.id)}"><label class="settings-field">Entry<textarea name="body" rows="4" data-notebook-draft="edit:${esc(entry.id)}">${esc(view.drafts[`edit:${entry.id}`] ?? entry.body)}</textarea></label><div class="row"><button class="btn primary" type="submit" ${disabled}>Save</button><button class="btn" type="button" data-notebook="cancel" ${disabled}>Cancel</button></div>${failure(view, `edit:${entry.id}`)}</form></div></li>`;
  const actions =
    view.removing === entry.id
      ? `<span>Remove this entry?</span><button class="btn primary" type="button" data-notebook-remove="${esc(entry.id)}" ${disabled}>Remove</button><button class="btn" type="button" data-notebook="cancel" ${disabled}>Keep</button>`
      : `<button class="btn" type="button" data-notebook-edit="${esc(entry.id)}" ${disabled}>Edit</button><button class="btn" type="button" data-notebook-ask-remove="${esc(entry.id)}" ${disabled}>Remove</button>`;
  return `<li><div class="card"><div class="col"><p>${text(entry.body)}</p><div class="row">${actions}</div>${failure(view, `remove:${entry.id}`)}</div></div></li>`;
}

function renderChange(view: NotebookView, change: Change): string {
  const who = change.actor ?? (change.item ? "An agent" : "Someone");
  const line = `${esc(who)} ${VERBS[change.action]}, ${esc(change.item ?? "on the dashboard")}, ${esc(when(change.at))}`;
  const detail =
    change.action === "patch"
      ? `<p class="sub">Before: ${text(change.before ?? "")}</p><p class="sub">After: ${text(change.after ?? "")}</p>`
      : `<p class="sub">${text(change.after ?? change.before ?? "")}</p>`;
  const undo = change.undoable
    ? `<div class="row"><button class="btn" type="button" data-notebook-undo="${esc(change.id)}" ${view.busy ? "disabled" : ""}>Undo</button></div>`
    : "";
  return `<li><div class="col"><p>${line}</p>${detail}${undo}${failure(view, `undo:${change.id}`)}</div></li>`;
}

function renderOpen(view: NotebookView, notebook: Notebook): string {
  const name =
    view.list?.find((entry) => entry.kind === notebook.kind && entry.id === notebook.id)?.name ??
    notebook.id;
  const ratio = notebook.limit === 0 ? 0 : notebook.size / notebook.limit;
  const level = ratio >= 1 ? " full" : ratio >= 0.85 ? " high" : "";
  const sizeText = characters(notebook.size, notebook.limit);
  const entries =
    notebook.entries.length === 0
      ? `<p class="empty">${NOTEBOOK_EMPTY}</p>`
      : `<ol role="list" class="col" aria-label="Entries">${notebook.entries.map((entry) => renderEntry(view, entry)).join("")}</ol>`;
  const changes = [...notebook.changes].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
  const history =
    changes.length === 0
      ? '<p class="sub">No changes yet.</p>'
      : `<ol role="list" aria-label="History">${changes.map((change) => renderChange(view, change)).join("")}</ol>`;
  return `<div class="row"><button class="btn" type="button" data-notebook="back" ${view.busy ? "disabled" : ""}>All notebooks</button></div>
<div class="col"><h2>${esc(name)}</h2><progress class="meter${level}" max="${notebook.limit}" value="${Math.min(notebook.size, notebook.limit)}" aria-label="${sizeText}"></progress><p>${sizeText}</p></div>
${failure(view, "open")}${entries}
<form class="col" data-notebook-form="add"><h2>Add an entry</h2><label class="settings-field">New entry<textarea name="body" rows="4" data-notebook-draft="add">${esc(view.drafts.add ?? "")}</textarea></label><div class="row"><button class="btn primary" type="submit" ${view.busy ? "disabled" : ""}>Add</button></div>${failure(view, "add")}</form>
<div class="col"><h2>History</h2>${history}</div>`;
}

export function renderNotebookSettings(view: NotebookView): string {
  const body = view.open
    ? renderOpen(view, view.open)
    : view.list
      ? renderList(view, view.list)
      : view.error
        ? failure(view, view.error.at)
        : '<p class="settings-message" role="status">Loading notebooks…</p>';
  return `<div class="col notebook">${body}</div>`;
}

const blank = (): NotebookView => ({
  list: null,
  open: null,
  busy: false,
  editing: null,
  removing: null,
  drafts: {},
  error: null,
});

export function createNotebookSettings(): {
  mount(root: HTMLElement, engine: string | null): void;
} {
  let root: HTMLElement | null = null;
  let engine: string | null = null;
  let view = blank();
  const paint = () => {
    if (root) renderMarkup(root, renderNotebookSettings(view));
  };
  const request = async (at: string, path: string, body?: unknown) => {
    if (!engine) return;
    const current = engine;
    view = { ...view, busy: true, error: null };
    paint();
    try {
      const response = await fetch(new URL(path, current), {
        method: body === undefined ? "GET" : "POST",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          ...(body === undefined
            ? {}
            : { "Content-Type": "application/json", "x-paws-csrf": readCsrfToken(document) }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json().catch(() => ({}));
      if (current !== engine) return;
      if (data.notebook) view.open = data.notebook as Notebook;
      if (!response.ok) {
        const reason = typeof data.error === "string" ? data.error : "";
        view.error = {
          at,
          text: reason ? notebookError(reason) : `Request failed (${response.status}).`,
        };
      } else if (Array.isArray(data.notebooks)) {
        const order = (kind: Kind) => (kind === "repository" ? 0 : 1);
        view.list = [...(data.notebooks as Summary[])].sort(
          (a, b) => order(a.kind) - order(b.kind) || a.name.localeCompare(b.name),
        );
      } else {
        view.open = data as Notebook;
        view.editing = view.removing = null;
        const { [at]: _done, ...drafts } = view.drafts;
        view.drafts = drafts;
      }
    } catch (error) {
      journalCaught(error, "notebook-settings.createNotebookSettings.request", null);
      if (current !== engine) return;
      view.error = { at, text: error instanceof Error ? error.message : "Could not load." };
    }
    view.busy = false;
    paint();
  };
  const edit = (operations: unknown[], at: string) => {
    if (view.open)
      void request(at, `${pathOf(view.open.kind, view.open.id)}/edits`, { operations });
  };
  const entry = (id: string) => view.open?.entries.find((candidate) => candidate.id === id);
  const click = (event: Event) => {
    const button = (event.target as Element).closest<HTMLElement>("button");
    if (!button || view.busy || !root?.contains(button)) return;
    const data = button.dataset;
    if (data.notebookOpen) {
      const [kind, ...rest] = data.notebookOpen.split(":");
      void request("open", pathOf(kind as Kind, rest.join(":")));
    } else if (data.notebook === "back") {
      view = { ...view, open: null, editing: null, removing: null, error: null };
      void request("list", "/api/notebooks");
    } else if (data.notebook === "cancel") {
      const { [`edit:${view.editing}`]: _dropped, ...drafts } = view.drafts;
      view = { ...view, drafts, editing: null, removing: null, error: null };
      paint();
    } else if (data.notebookEdit) {
      view = { ...view, editing: data.notebookEdit, removing: null, error: null };
      paint();
    } else if (data.notebookAskRemove) {
      view = { ...view, removing: data.notebookAskRemove, editing: null, error: null };
      paint();
    } else if (data.notebookRemove) {
      const target = entry(data.notebookRemove);
      if (target)
        edit([{ action: "remove", old_text: target.body }], `remove:${data.notebookRemove}`);
    } else if (data.notebookUndo && view.open) {
      const path = `${pathOf(view.open.kind, view.open.id)}/undo`;
      void request(`undo:${data.notebookUndo}`, path, { changeId: data.notebookUndo });
    }
  };
  const input = (event: Event) => {
    const field = event.target as HTMLTextAreaElement;
    const key = field.dataset?.notebookDraft;
    if (key) view.drafts = { ...view.drafts, [key]: field.value };
  };
  const submit = (event: Event) => {
    const form = event.target as HTMLFormElement;
    const at = form.dataset?.notebookForm;
    if (!at) return;
    event.preventDefault();
    if (view.busy) return;
    const content = form.querySelector("textarea")?.value ?? "";
    view.drafts = { ...view.drafts, [at]: content };
    if (at === "add") return edit([{ action: "add", content }], at);
    const target = entry(at.slice("edit:".length));
    if (target) edit([{ action: "patch", old_text: target.body, content }], at);
  };
  return {
    mount(next, nextEngine) {
      if (root === next && engine === nextEngine) return;
      root?.removeEventListener("click", click);
      root?.removeEventListener("input", input);
      root?.removeEventListener("submit", submit);
      if (engine !== nextEngine) view = blank();
      root = next;
      engine = nextEngine;
      root.addEventListener("click", click);
      root.addEventListener("input", input);
      root.addEventListener("submit", submit);
      if (!engine) {
        view.error = { at: "list", text: "Connect to your Paws dashboard to read notebooks." };
        paint();
      } else if (!view.list && !view.busy) void request("list", "/api/notebooks");
      else paint();
    },
  };
}
