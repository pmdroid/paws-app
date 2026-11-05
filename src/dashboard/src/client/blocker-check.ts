import { readCsrfToken } from "./csrf";

export function createBlockerCheck(reload: () => Promise<void>) {
  let pending = "";
  let message = "";
  return {
    mount(element: HTMLElement, engineUrl: string | null, source: string | undefined) {
      const local =
        engineUrl !== null && new URL(engineUrl).origin === location.origin && source === "live";
      const status = element.querySelector<HTMLElement>("[data-blocker-message]");
      if (status) status.textContent = message;
      const button = element.querySelector<HTMLButtonElement>("[data-check-blockers]");
      if (!button) return;
      const itemId = button.dataset["checkBlockers"] ?? "";
      button.hidden = !local;
      button.disabled = pending === itemId;
      if (pending === itemId) button.textContent = "Checking…";
      button.onclick = () => void check(itemId);
    },
  };
  async function check(itemId: string) {
    if (!itemId || pending) return;
    pending = itemId;
    message = "";
    try {
      const response = await fetch("/api/blocker-checks", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-paws-csrf": readCsrfToken(document) },
        body: JSON.stringify({ itemId }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(
          typeof body === "object" && body && "error" in body && typeof body.error === "string"
            ? body.error
            : "The check failed. Refresh and try again.",
        );
      message =
        typeof body === "object" && body && "changed" in body && body.changed
          ? "Blockers changed in Linear. Paws updated the item."
          : "Blockers checked. Nothing changed in Linear.";
    } catch (error) {
      message = error instanceof Error ? error.message : "The check failed. Try again.";
    } finally {
      pending = "";
      await reload();
    }
  }
}
