import { journalCaught } from "../../../journal";
import { renderMarkup } from "./theme";
import { LINEAR_SESSION_API_PATH } from "../session-start";
import { esc } from "./format";
import { readCsrfToken } from "./csrf";

export function createSessionStart(reload: () => Promise<void>) {
  let root: HTMLElement | null = null;
  let checked = false;
  let available = false;
  let local = false;
  let visible = true;
  return {
    mount(element: HTMLElement, engineUrl: string | null, source: string | undefined, show = true) {
      root = element;
      visible = show;
      local =
        engineUrl !== null && new URL(engineUrl).origin === location.origin && source === "live";
      element.hidden = !local || !available || !visible;
      if (!local || checked) return;
      checked = true;
      void fetch(LINEAR_SESSION_API_PATH, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      })
        .then(async (response) => (response.ok ? (response.json() as Promise<unknown>) : null))
        .then((body) => {
          available =
            typeof body === "object" &&
            body !== null &&
            "available" in body &&
            body.available === true;
          if (!root || !available) return;
          renderMarkup(root, renderSessionStart());
          root.querySelector("form")?.addEventListener("submit", (event) => {
            event.preventDefault();
            void submit();
          });
          root.hidden = !local || !visible;
        })
        .catch((caughtError1) => {
          journalCaught(caughtError1, "session-start.mount.then", null);
          return undefined;
        });
    },
  };

  async function submit(): Promise<void> {
    const form = root?.querySelector<HTMLFormElement>("form");
    const button = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
    const status = root?.querySelector<HTMLElement>("[data-session-status]");
    if (!form || !button || !status || button.disabled) return;
    const target = new FormData(form).get("target");
    if (typeof target !== "string") return;
    button.disabled = true;
    button.textContent = "Starting…";
    status.textContent = "";
    try {
      const response = await fetch(LINEAR_SESSION_API_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-paws-csrf": readCsrfToken(document) },
        body: JSON.stringify({ target }),
      });
      const body: unknown = await response.json();
      if (!response.ok)
        throw new Error(
          typeof body === "object" &&
            body !== null &&
            "error" in body &&
            typeof body.error === "string"
            ? body.error
            : "The session could not be started.",
        );
      if (
        typeof body !== "object" ||
        body === null ||
        !("id" in body) ||
        typeof body.id !== "string"
      )
        throw new Error("Linear returned no session.");
      const url = "url" in body && typeof body.url === "string" ? safeLinearUrl(body.url) : null;
      renderMarkup(
        status,
        `Session started.${url ? ` <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open in Linear</a>` : ""}`,
      );
      form.reset();
      await reload();
    } catch (error) {
      journalCaught(error, "session-start.submit.fetch", null);
      status.textContent =
        error instanceof Error ? error.message : "The session could not be started.";
    } finally {
      button.disabled = false;
      button.textContent = "Start session";
    }
  }
}

export function renderSessionStart(): string {
  return `<details class="linear-session-start"><summary>Start Linear session</summary>
    <form><label class="field"><span>Issue or comment thread</span><input name="target" required maxlength="2048" autocomplete="off" spellcheck="false" placeholder="ENG-123 or a Linear comment link" aria-describedby="linear-session-hint" /></label>
    <p class="muted" id="linear-session-hint">Paste an issue identifier or copy the link to a root comment thread.</p>
    <button type="submit" class="btn primary">Start session</button></form>
    <p data-session-status role="status" aria-live="polite"></p></details>`;
}

function safeLinearUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.origin === "https://linear.app" ? url.href : null;
  } catch (caughtError2) {
    journalCaught(caughtError2, "session-start.safeLinearUrl", null);
    return null;
  }
}
