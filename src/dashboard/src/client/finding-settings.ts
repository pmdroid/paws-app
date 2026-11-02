import { journalCaught } from "../journal";
import { renderMarkup } from "./theme";
import { esc } from "./format";
import { readCsrfToken } from "./csrf";

export type FindingSettings = { grouping: boolean; groupingTime: string };

export type FindingSettingsView = {
  data: FindingSettings | null;
  busy: string | null;
  error: string | null;
  denied?: boolean;
};

const PATH = "/api/settings/findings";

const intro =
  '<div class="settings-label"><h2>Daily grouping</h2><p class="sub">Group similar review findings into one suggested fix, once per UTC day. Each run uses one helper turn on an admin\'s runner.</p></div>';

export function renderFindingSettings(view: FindingSettingsView): string {
  if (view.denied)
    return `<section class="settings-section">${intro}<p class="sub">Only workspace admins can change finding settings.</p></section>`;
  if (!view.data)
    return `<section class="settings-section">${intro}<div class="col"><div class="settings-message" role="${view.error ? "alert" : "status"}">${esc(view.error ?? "Loading finding settings…")}</div>${view.error ? '<div class="row"><button class="btn" type="button" data-finding-settings="reload">Try again</button></div>' : ""}</div></section>`;
  const feedback = view.error
    ? `<p class="settings-message err" role="alert">${esc(view.error)}</p>`
    : view.busy
      ? `<p class="settings-message" role="status">${esc(view.busy)}</p>`
      : "";
  return `<section class="settings-section">${intro}<div class="col">
    <label class="settings-inherit"><input type="checkbox" name="finding-grouping" ${view.data.grouping ? "checked" : ""} ${view.busy ? "disabled" : ""} aria-describedby="finding-grouping-help">Group findings daily</label>
    <small class="sub" id="finding-grouping-help">${view.data.grouping ? `Runs at ${esc(view.data.groupingTime)} UTC.` : "Off. No helper turns are spent and Run now is hidden. Existing groups stay on the Findings page."}</small>${feedback}</div></section>`;
}

async function findingSettingsRequest(
  engine: string,
  body?: { grouping: boolean },
): Promise<FindingSettings> {
  const response = await fetch(new URL(PATH, engine), {
    method: body ? "POST" : "GET",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(body
        ? { "Content-Type": "application/json", "x-paws-csrf": readCsrfToken(document) }
        : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch((error) => {
    journalCaught(error, "finding-settings.findingSettingsRequest.json", null);
    return {};
  });
  if (!response.ok)
    throw new Error(
      typeof data.error === "string" ? data.error : `Request failed (${response.status}).`,
      { cause: response.status },
    );
  return data as FindingSettings;
}

export function createFindingSettings(): {
  mount(root: HTMLElement, engine: string | null): void;
} {
  let root: HTMLElement | null = null;
  let engine: string | null = null;
  let generation = 0;
  let view: FindingSettingsView = { data: null, busy: null, error: null };
  const paint = () => {
    if (root) renderMarkup(root, renderFindingSettings(view));
  };
  const run = async (busy: string, body?: { grouping: boolean }) => {
    if (!engine) return;
    const started = generation;
    view.busy = busy;
    view.error = null;
    paint();
    try {
      const data = await findingSettingsRequest(engine, body);
      if (started !== generation) return;
      view.data = data;
      view.denied = false;
    } catch (error) {
      journalCaught(error, "finding-settings.createFindingSettings.request", null);
      if (started !== generation) return;
      if (error instanceof Error && error.cause === 403 && !body) view.denied = true;
      else view.error = error instanceof Error ? error.message : "Could not change grouping.";
    }
    view.busy = null;
    paint();
  };
  const click = (event: Event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>(
      '[data-finding-settings="reload"]',
    );
    if (button && !view.busy) void run("Loading finding settings…");
  };
  const change = (event: Event) => {
    const input = event.target as HTMLInputElement;
    if (input.name !== "finding-grouping" || view.busy) return;
    void run(input.checked ? "Turning grouping on…" : "Turning grouping off…", {
      grouping: input.checked,
    });
  };
  return {
    mount(next, nextEngine) {
      if (root === next && engine === nextEngine) return;
      root?.removeEventListener("click", click);
      root?.removeEventListener("change", change);
      if (engine !== nextEngine) {
        generation += 1;
        view = { data: null, busy: null, error: null };
      }
      root = next;
      engine = nextEngine;
      root.addEventListener("click", click);
      root.addEventListener("change", change);
      if (!engine) {
        view.error = "Connect to your Paws dashboard to manage finding settings.";
        paint();
      } else if (!view.data && !view.busy && !view.denied) void run("Loading finding settings…");
      else paint();
    },
  };
}
