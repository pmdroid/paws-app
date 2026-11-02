import { readCsrfToken } from "./csrf";

/** Wires the Retry buttons when the page reads a live engine on this origin. */
export function createDeadDeliveryRetry(reload: () => Promise<void>) {
  const pending = new Set<string>();
  let message = "";
  return {
    mount(element: HTMLElement, engineUrl: string | null, source: string | undefined) {
      const local =
        engineUrl !== null && new URL(engineUrl).origin === location.origin && source === "live";
      const status = element.querySelector<HTMLElement>("[data-dead-message]");
      if (status) status.textContent = message;
      for (const button of element.querySelectorAll<HTMLButtonElement>("[data-retry]")) {
        const target = button.dataset["retry"] ?? "";
        button.hidden = !local;
        button.disabled = pending.has(target);
        if (pending.has(target)) button.textContent = "Retrying…";
        button.onclick = () => void retry(target);
      }
    },
  };
  async function retry(target: string) {
    if (!target || pending.has(target)) return;
    pending.add(target);
    message = "";
    try {
      const response = await fetch("/api/execution-controls", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-paws-csrf": readCsrfToken(document) },
        body: JSON.stringify({ action: "retry", target }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(
          typeof body === "object" && body && "error" in body && typeof body.error === "string"
            ? body.error
            : "The retry failed. Refresh and try again.",
        );
      message = "Paws is trying again.";
    } catch (error) {
      message = error instanceof Error ? error.message : "The retry failed. Try again.";
    } finally {
      pending.delete(target);
      await reload();
    }
  }
}
