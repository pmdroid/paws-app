import { journalCaught } from "../journal";
import { renderMarkup } from "./theme";
import { readCsrfToken } from "./csrf";
import { esc } from "./format";

const LABELS: Record<string, string> = {
  pause: "Pause item",
  resume: "Resume item",
  resume_now: "Resume now",
  clear_stuck_agent: "Clear stuck agent",
};

export function createExecutionControls(reload: () => Promise<void>) {
  let root: HTMLElement | null = null;
  let itemId = "";
  let generation = 0;
  let actions: string[] = [];
  let pending = "";
  let message = "";
  let notice = "";
  let confirming = false;
  let painted = "";
  // Items that answered "no controls", with the version they had then.
  const none = new Map<string, string>();
  function paint() {
    if (!root) return;
    root.hidden = actions.length === 0 && !notice;
    // Hidden content is not seen; it renders when there is something to show.
    if (root.hidden) return;
    const html = `<div class="row wrap" aria-label="Item execution controls" aria-busy="${Boolean(pending)}">${actions
      .filter((action) => action !== "stop")
      .map(
        (action) =>
          `<button class="btn sm" type="button" data-control="${action}"${pending ? ' disabled=""' : ""}>${pending === action ? `${action === "pause" ? "Pausing" : action === "clear_stuck_agent" ? "Clearing" : "Resuming"}…` : LABELS[action]}</button>`,
      )
      .join(
        "",
      )}${actions.includes("stop") ? `<details${confirming ? ' open=""' : ""}><summary class="btn sm">${actions.includes("resume_now") ? "Stop" : "Stop this item"}</summary><p>Stop this item and keep its branch?</p><button class="btn sm" type="button" data-control="stop"${pending ? ' disabled=""' : ""}>${pending === "stop" ? "Stopping…" : "Confirm stop"}</button></details>` : ""}</div>${notice ? `<p class="muted">${esc(notice)}</p>` : ""}<p class="muted" role="status">${esc(message)}</p>`;
    if (painted === html) return;
    painted = html;
    renderMarkup(root, html);
    root.querySelector("details")?.addEventListener("toggle", (event) => {
      confirming = (event.currentTarget as HTMLDetailsElement).open;
    });
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-control]"))
      button.addEventListener("click", () => void submit(button.dataset["control"]!));
  }
  async function submit(action: string) {
    if (pending || !itemId) return;
    const target = itemId;
    const acceptedGeneration = generation;
    pending = action;
    message = "";
    paint();
    try {
      const response = await fetch("/api/execution-controls", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-paws-csrf": readCsrfToken(document) },
        body: JSON.stringify({ itemId: target, action }),
      });
      const body: unknown = await response.json();
      if (!response.ok)
        throw new Error(
          typeof body === "object" && body && "error" in body && typeof body.error === "string"
            ? body.error
            : "The action failed. Refresh and try again.",
        );
      if (acceptedGeneration === generation) {
        message =
          action === "stop"
            ? "Item stopped."
            : action === "pause"
              ? "Item paused."
              : action === "resume_now"
                ? "Paws is trying the agent again."
                : action === "clear_stuck_agent"
                  ? "Paws will continue with the waiting replies."
                  : "Item resumed.";
        actions = [];
        notice = "";
      }
      pending = "";
      await reload();
    } catch (error) {
      journalCaught(error, "execution-controls.submit.fetch", itemId);
      if (acceptedGeneration === generation)
        message = error instanceof Error ? error.message : "The action failed. Try again.";
    } finally {
      pending = "";
      paint();
    }
  }
  return {
    mount(element: HTMLElement, engineUrl: string | null, source: string | undefined) {
      if (root !== element) painted = "";
      root = element;
      const selected = element.dataset["item"] ?? "";
      const local =
        engineUrl !== null && new URL(engineUrl).origin === location.origin && source === "live";
      if (!local || selected !== itemId) {
        generation += 1;
        actions = [];
        message = "";
        notice = "";
        confirming = false;
        itemId = local ? selected : "";
      }
      if (local && itemId && !pending && element.dataset["noControls"] !== undefined) {
        generation += 1;
        actions = [];
        notice = "";
      }
      paint();
      if (!local || !itemId || pending || element.dataset["noControls"] !== undefined) return;
      const version = element.dataset["version"];
      if (version !== undefined && none.get(itemId) === version) return;
      const target = itemId;
      const requestedGeneration = ++generation;
      void fetch(`/api/execution-controls?itemId=${encodeURIComponent(target)}`, {
        cache: "no-store",
      })
        .then(async (response) => (response.ok ? (response.json() as Promise<unknown>) : null))
        .then((body) => {
          if (requestedGeneration !== generation) return;
          actions =
            typeof body === "object" &&
            body !== null &&
            "available" in body &&
            body.available === true &&
            "actions" in body &&
            Array.isArray(body.actions)
              ? body.actions.filter((action): action is string =>
                  ["stop", "pause", "resume", "resume_now", "clear_stuck_agent"].includes(action),
                )
              : [];
          notice =
            typeof body === "object" &&
            body !== null &&
            "notice" in body &&
            typeof body.notice === "string"
              ? body.notice
              : "";
          if (
            version !== undefined &&
            actions.length === 0 &&
            !notice &&
            typeof body === "object" &&
            body !== null &&
            "available" in body &&
            body.available === true
          )
            none.set(target, version);
          else none.delete(target);
          paint();
        })
        .catch((caughtError1) => {
          journalCaught(caughtError1, "execution-controls.mount.then", itemId);
          if (requestedGeneration === generation) {
            actions = [];
            paint();
          }
        });
    },
  };
}
