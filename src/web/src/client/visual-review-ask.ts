import { journalCaught } from "../journal";
import { readCsrfToken } from "./csrf";
import { linkAskPending, setLinkAskDraft, setLinkAskStatus } from "./link-ask";
import { openReviewDraw, sendReviewChanges, type ReviewShot } from "./review-draw";

/** The screenshots on the Visual review card a person can draw on. */
function cardShots(card: Element): ReviewShot[] {
  return [...card.querySelectorAll<HTMLElement>("[data-review-shot]")].map((frame) => ({
    id: frame.dataset["evidenceId"] ?? "",
    name: frame.dataset["name"] ?? "",
    src: frame.dataset["src"] ?? "",
  }));
}

/**
 * Approve posts the link ask decision; Request changes sends the note with
 * each marked screenshot. Returns whether the event was the card's form.
 */
export function submitVisualReviewAsk(event: SubmitEvent, reload: () => Promise<void>): boolean {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || form.dataset["visualReviewAsk"] === undefined)
    return false;
  event.preventDefault();
  const questionId = form.dataset["visualReviewAsk"];
  if (linkAskPending(questionId)) return true;
  const decision = event.submitter instanceof HTMLButtonElement ? event.submitter.value : "";
  if (decision !== "approve" && decision !== "changes") return true;
  const note = form.querySelector("textarea")?.value ?? "";
  const shots = cardShots(form.closest("section") ?? form);
  setLinkAskStatus(questionId, "Sending…", true);
  const status = form.querySelector("[role=status]");
  if (status) status.textContent = "Sending…";
  void (async () => {
    try {
      if (decision === "changes") await sendReviewChanges(questionId, shots, note);
      else {
        const response = await fetch("/api/link-asks", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-paws-csrf": readCsrfToken(document) },
          body: JSON.stringify({ questionId, decision: "approve", note: "" }),
        });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok)
          throw new Error(
            typeof body === "object" && body && "error" in body && typeof body.error === "string"
              ? body.error
              : "The approval was not sent. Refresh and try again.",
          );
      }
      setLinkAskDraft(questionId, null);
      setLinkAskStatus(
        questionId,
        decision === "approve" ? "Approved." : "Changes requested.",
        false,
      );
    } catch (error) {
      journalCaught(error, "visual-review-ask.submit", null);
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

/**
 * A click on a screenshot of the card opens the drawing dialog on it, when
 * the screenshots come from this origin so the marks can be drawn into them.
 * Stop stops the item through the execution controls. Returns whether it handled the click.
 */
export function clickVisualReviewAsk(
  event: MouseEvent,
  local: boolean,
  reload: () => Promise<void>,
): boolean {
  if (!(event.target instanceof Element)) return false;
  const stop = event.target.closest<HTMLButtonElement>("[data-visual-review-stop]");
  if (stop) {
    event.preventDefault();
    stopItem(stop, reload);
    return true;
  }
  const frame = event.target.closest<HTMLElement>("[data-review-draw]");
  if (!frame || !local || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey)
    return false;
  event.preventDefault();
  const card = frame.closest("section");
  if (!card) return true;
  openReviewDraw(frame.dataset["reviewDraw"] ?? "", cardShots(card), reload, {
    collect: true,
    start: Number(frame.dataset["reviewShot"] ?? 0),
  });
  return true;
}

function stopItem(button: HTMLButtonElement, reload: () => Promise<void>): void {
  const itemId = button.dataset["visualReviewStop"] ?? "";
  const status = button.closest("section")?.querySelector("form [role=status]");
  button.disabled = true;
  void (async () => {
    try {
      const response = await fetch("/api/execution-controls", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-paws-csrf": readCsrfToken(document) },
        body: JSON.stringify({ itemId, action: "stop" }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(
          typeof body === "object" && body && "error" in body && typeof body.error === "string"
            ? body.error
            : "The item was not stopped. Refresh and try again.",
        );
      if (status) status.textContent = "Item stopped.";
    } catch (error) {
      journalCaught(error, "visual-review-ask.stop", itemId);
      if (status)
        status.textContent = error instanceof Error ? error.message : "The item was not stopped.";
      button.disabled = false;
    }
    await reload();
  })();
}
