import { journalCaught } from "../journal";
import type { AgentSettings } from "../agent-settings";
import { settingsRequest } from "./agent-settings";
import { readCsrfToken } from "./csrf";
import { esc } from "./format";
import { renderMarkup } from "./theme";

const QUEUE_START_TIMEOUT_DEFAULT = 24;
const QUEUE_START_TIMEOUT_MAX = 720;
const OWNER_CAP_MAX = 1000;

export type QueueSettings = NonNullable<AgentSettings["queue"]>;
export type QueueView = {
  queue: QueueSettings | null;
  busy: string | null;
  error: string | null;
  saved: boolean;
  denied?: boolean;
};

export function queueProblems(queue: QueueSettings): string[] {
  const problems: string[] = [];
  const hours = queue.startTimeoutHours;
  if (!Number.isInteger(hours) || hours < 1 || hours > QUEUE_START_TIMEOUT_MAX)
    problems.push(
      `Queue start timeout: enter a whole number of hours from 1 to ${QUEUE_START_TIMEOUT_MAX}.`,
    );
  const cap = queue.maxRunningPerOwner ?? null;
  if (cap !== null && (!Number.isInteger(cap) || cap < 1 || cap > OWNER_CAP_MAX))
    problems.push(
      `Running items per owner: leave empty for no cap, or enter a whole number from 1 to ${OWNER_CAP_MAX}.`,
    );
  return problems;
}

const intro =
  '<div class="settings-label"><h2>Queue</h2><p class="sub">While every runner slot is busy, a delegated item waits in line and Linear shows its place.</p></div>';

export function renderQueueSettings(view: QueueView): string {
  if (view.denied)
    return `<section class="settings-section">${intro}<p class="sub">Only workspace admins can change queue settings.</p></section>`;
  if (!view.queue)
    return `<section class="settings-section">${intro}<div class="col"><div class="settings-message" role="${view.error ? "alert" : "status"}">${esc(view.error ?? "Loading queue settings…")}</div>${view.error ? '<div class="row"><button class="btn" type="button" data-queue-settings="reload">Try again</button></div>' : ""}</div></section>`;
  const hours = view.queue.startTimeoutHours;
  const cap = view.queue.maxRunningPerOwner ?? null;
  const problems = queueProblems(view.queue);
  const feedback = view.error
    ? `<p class="settings-message err" role="alert">${esc(view.error)}</p>`
    : view.busy
      ? `<p class="settings-message" role="status">${esc(view.busy)}</p>`
      : view.saved
        ? '<p class="settings-message" role="status">Saved</p>'
        : "";
  return `<section class="settings-section">${intro}<form id="queue-settings-form" class="col">
      <label for="queue-start-timeout">Fail an item that has not started after, in hours</label><input id="queue-start-timeout" name="queue-start-timeout" type="number" inputmode="numeric" min="1" max="${QUEUE_START_TIMEOUT_MAX}" step="1" required value="${Number.isFinite(hours) ? hours : ""}" aria-describedby="queue-start-timeout-help">
      <p class="sub" id="queue-start-timeout-help">From 1 to ${QUEUE_START_TIMEOUT_MAX} hours. The default is ${QUEUE_START_TIMEOUT_DEFAULT}. Paws then fails the item in Linear, and delegating it again retries.</p>
      <label for="queue-owner-cap">Most items one person or project runs at once</label><input id="queue-owner-cap" name="queue-owner-cap" type="number" inputmode="numeric" min="1" max="${OWNER_CAP_MAX}" step="1" value="${cap !== null && Number.isFinite(cap) ? cap : ""}" aria-describedby="queue-owner-cap-help">
      <p class="sub" id="queue-owner-cap-help">Free runners take turns between the people and projects with queued work. Empty means no cap, so one person alone still gets every runner.</p>
      <div id="queue-problems" class="settings-message err" role="alert" ${problems.length ? "" : "hidden"}>${problems.map(esc).join("<br>")}</div>
      ${feedback}<div class="row"><button class="btn" type="submit" ${view.busy || problems.length ? "disabled" : ""}>Save queue settings</button></div></form></section>`;
}

export function createQueueSettings(onSaved: () => void = () => {}): {
  mount(root: HTMLElement, engine: string | null): void;
} {
  let root: HTMLElement | null = null;
  let engine: string | null = null;
  let generation = 0;
  const fresh = (): QueueView => ({ queue: null, busy: null, error: null, saved: false });
  let view = fresh();
  const paint = () => {
    if (root) renderMarkup(root, renderQueueSettings(view));
  };
  const read = (settings: AgentSettings): QueueSettings => ({
    startTimeoutHours: settings.queue?.startTimeoutHours ?? QUEUE_START_TIMEOUT_DEFAULT,
    maxRunningPerOwner: settings.queue?.maxRunningPerOwner ?? null,
  });
  const run = async (busy: string, queue?: QueueSettings) => {
    if (!engine) return;
    const started = generation;
    Object.assign(view, { busy, error: null, saved: false });
    paint();
    try {
      let settings = await settingsRequest<AgentSettings>(engine, "GET");
      if (queue) {
        const { merge: _merge, ...agents } = settings;
        settings = await settingsRequest<AgentSettings>(
          engine,
          "PUT",
          { ...agents, queue },
          readCsrfToken(document),
        );
      }
      if (queue) onSaved();
      if (started !== generation) return;
      Object.assign(view, { queue: read(settings), denied: false, saved: queue !== undefined });
    } catch (error) {
      journalCaught(error, "queue-settings.createQueueSettings.request", null);
      if (started !== generation) return;
      if (error instanceof Error && error.cause === 403 && !queue) view.denied = true;
      else view.error = error instanceof Error ? error.message : "Could not save queue settings.";
    }
    view.busy = null;
    paint();
  };
  const readForm = () => {
    if (!root || !view.queue) return;
    const value = (name: string) =>
      root?.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value.trim();
    const hours = value("queue-start-timeout");
    const cap = value("queue-owner-cap");
    view.queue = {
      startTimeoutHours: hours === undefined || hours === "" ? NaN : Number(hours),
      maxRunningPerOwner: cap ? Number(cap) : null,
    };
  };
  const input = (event: Event) => {
    if (!(event.target as Element).closest("#queue-settings-form")) return;
    readForm();
    view.saved = false;
    view.error = null;
    const problems = view.queue ? queueProblems(view.queue) : [];
    const holder = root?.querySelector<HTMLElement>("#queue-problems");
    if (holder) {
      holder.textContent = problems.join(" ");
      holder.hidden = problems.length === 0;
    }
    const save = root?.querySelector<HTMLButtonElement>('#queue-settings-form [type="submit"]');
    if (save) save.disabled = problems.length > 0 || view.busy !== null;
  };
  const click = (event: Event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-queue-settings]");
    if (button?.dataset.queueSettings === "reload" && !view.busy)
      void run("Loading queue settings…");
  };
  const submit = (event: Event) => {
    if ((event.target as Element).id !== "queue-settings-form") return;
    event.preventDefault();
    readForm();
    if (!view.queue || view.busy || queueProblems(view.queue).length) return paint();
    void run("Saving queue settings…", view.queue);
  };
  return {
    mount(next, nextEngine) {
      if (root === next && engine === nextEngine) return;
      root?.removeEventListener("click", click);
      root?.removeEventListener("input", input);
      root?.removeEventListener("submit", submit);
      if (engine !== nextEngine) {
        generation += 1;
        view = fresh();
      }
      root = next;
      engine = nextEngine;
      root.addEventListener("click", click);
      root.addEventListener("input", input);
      root.addEventListener("submit", submit);
      if (!engine) {
        view.error = "Connect to your Paws dashboard to manage queue settings.";
        paint();
      } else if (!view.queue && !view.busy && !view.denied) void run("Loading queue settings…");
      else paint();
    },
  };
}
