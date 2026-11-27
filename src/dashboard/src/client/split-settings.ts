import { journalCaught } from "../journal";
import { readCsrfToken } from "./csrf";
import { esc } from "./format";
import { settingsAreEditable } from "./settings-pages";
import { renderMarkup } from "./theme";

type SplitSettings = Record<"maxSubIssues" | "approvalsBeforeAuto" | "approvedSplits", number> & {
  enabled: boolean;
};
type SplitView = {
  data: SplitSettings | null;
  busy: string | null;
  error: string | null;
  saved: boolean;
};

const FIELDS: ["maxSubIssues" | "approvalsBeforeAuto", string, number, number, string][] = [
  ["maxSubIssues", "Most sub-issues in one split", 1, 5, "split-max-sub-issues"],
  ["approvalsBeforeAuto", "Approved splits before splits are automatic", 0, 10, "split-approvals"],
];

export function renderSplitSettings(view: SplitView, admin: boolean): string {
  const intro = `<div class="settings-label"><h2>Splits</h2><p class="sub">When an issue is too big for one pull request, the agent may split it into sub-issues. A person approves each split until enough have been approved.</p></div>`;
  const data = view.data;
  if (!data)
    return `<section class="settings-section">${intro}<div class="col"><div class="settings-message" role="${view.error ? "alert" : "status"}">${esc(view.error ?? "Loading split settings…")}</div>${view.error ? '<div class="row"><button class="btn" type="button" data-split-settings="reload">Try again</button></div>' : ""}</div></section>`;
  const off = admin ? "" : " disabled";
  const fields = FIELDS.map(
    ([key, label, min, max, id]) =>
      `<label for="${id}">${label}</label><input id="${id}" name="${key}" type="number" inputmode="numeric" min="${min}" max="${max}" step="1" value="${data[key]}" aria-describedby="${id}-help"${off}><p class="sub" id="${id}-help">From ${min} to ${max}.</p>`,
  ).join("");
  const feedback = view.error
    ? `<p class="settings-message err" role="alert">${esc(view.error)}</p>`
    : view.busy
      ? `<p class="settings-message" role="status">${esc(view.busy)}</p>`
      : view.saved
        ? '<p class="settings-message" role="status">Saved</p>'
        : "";
  const save = admin
    ? `<div class="row"><button class="btn" type="submit"${view.busy ? " disabled" : ""}>Save split settings</button></div>`
    : '<p class="sub">Only workspace admins can change splits.</p>';
  return `<section class="settings-section">${intro}<form id="split-settings-form" class="col" novalidate>
    <label class="settings-inherit"><input type="checkbox" role="switch" name="enabled"${data.enabled ? " checked" : ""}${off}><span class="min-w-0 flex-1">Let agents split too-big issues</span></label>
    ${fields}<p class="sub" id="split-progress">${data.approvedSplits} approved split${data.approvedSplits === 1 ? "" : "s"} so far; splits are automatic after ${data.approvalsBeforeAuto}.</p>
    ${feedback}${save}</form></section>`;
}

async function splitRequest(
  engine: string,
  method: "GET" | "PUT",
  body?: unknown,
): Promise<SplitSettings> {
  const response = await fetch(new URL("/api/settings/splits", engine), {
    method,
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(method === "GET"
        ? {}
        : { "Content-Type": "application/json", "x-paws-csrf": readCsrfToken(document) }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      typeof data.error === "string" ? data.error : `Request failed (${response.status}).`,
    );
  return data as SplitSettings;
}

export function createSplitSettings(): { mount(root: HTMLElement, engine: string | null): void } {
  let root: HTMLElement | null = null;
  let engine: string | null = null;
  let generation = 0;
  const fresh = (): SplitView => ({ data: null, busy: null, error: null, saved: false });
  let view = fresh();
  const paint = () => {
    if (root) renderMarkup(root, renderSplitSettings(view, settingsAreEditable()));
  };
  const run = async (busy: string, body?: Record<string, unknown>) => {
    if (!engine) return;
    const started = generation;
    Object.assign(view, { busy, error: null, saved: false });
    paint();
    try {
      const data = await splitRequest(engine, body ? "PUT" : "GET", body);
      if (started !== generation) return;
      Object.assign(view, { data, saved: body !== undefined });
    } catch (error) {
      journalCaught(error, "split-settings.createSplitSettings.request", null);
      if (started !== generation) return;
      view.error = error instanceof Error ? error.message : "Could not save split settings.";
    }
    view.busy = null;
    paint();
  };
  const click = (event: Event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-split-settings]");
    if (button && !view.busy) void run("Loading split settings…");
  };
  const submit = (event: Event) => {
    const form = event.target as HTMLFormElement;
    if (form.id !== "split-settings-form") return;
    event.preventDefault();
    if (view.busy || !settingsAreEditable()) return;
    const number = (name: string) => {
      const value = form.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value.trim() ?? "";
      return value === "" ? null : Number(value);
    };
    void run("Saving split settings…", {
      enabled: form.querySelector<HTMLInputElement>('[name="enabled"]')?.checked ?? false,
      maxSubIssues: number("maxSubIssues"),
      approvalsBeforeAuto: number("approvalsBeforeAuto"),
    });
  };
  return {
    mount(next, nextEngine) {
      if (root === next && engine === nextEngine) return;
      root?.removeEventListener("click", click);
      root?.removeEventListener("submit", submit);
      if (engine !== nextEngine) {
        generation += 1;
        view = fresh();
      }
      root = next;
      engine = nextEngine;
      root.addEventListener("click", click);
      root.addEventListener("submit", submit);
      if (!engine) {
        view.error = "Connect to your Paws dashboard to manage split settings.";
        paint();
      } else if (!view.data && !view.busy) void run("Loading split settings…");
      else paint();
    },
  };
}
