import { journalCaught } from "../journal";
import { readCsrfToken } from "./csrf";
import { linkAskPending, setLinkAskDraft, setLinkAskStatus } from "./link-ask";

/** Keeps what a person typed in a link ask card across repaints. */
export function rememberLinkAskDraft(target: EventTarget | null): void {
  if (!(target instanceof HTMLTextAreaElement)) return;
  const id = target.closest<HTMLElement>("[data-link-ask]")?.dataset["linkAsk"];
  if (id) setLinkAskDraft(id, target.value);
}

/** Posts the decision with the CSRF token. Returns whether the event was a link ask form. */
export function submitLinkAsk(event: SubmitEvent, reload: () => Promise<void>): boolean {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || form.dataset["linkAsk"] === undefined) return false;
  event.preventDefault();
  const questionId = form.dataset["linkAsk"];
  if (linkAskPending(questionId)) return true;
  const decision = event.submitter instanceof HTMLButtonElement ? event.submitter.value : "approve";
  const note = form.querySelector("textarea")?.value ?? "";
  setLinkAskStatus(questionId, "Sending…", true);
  const status = form.querySelector("[role=status]");
  if (status) status.textContent = "Sending…";
  void (async () => {
    try {
      const response = await fetch("/api/link-asks", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-paws-csrf": readCsrfToken(document) },
        body: JSON.stringify({ questionId, decision, note }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(
          typeof body === "object" && body && "error" in body && typeof body.error === "string"
            ? body.error
            : "The decision was not sent. Refresh and try again.",
        );
      setLinkAskDraft(questionId, null);
      setLinkAskStatus(questionId, "Decision sent.", false);
    } catch (error) {
      journalCaught(error, "link-ask.submit.fetch", null);
      setLinkAskStatus(
        questionId,
        error instanceof Error ? error.message : "The decision was not sent. Try again.",
        false,
      );
    }
    await reload();
  })();
  return true;
}
