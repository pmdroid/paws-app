import { journalCaught } from "../journal";
import { readCsrfToken } from "./csrf";
import {
  bypassLabel,
  linkAskPending,
  setBypassReason,
  setBypassSelection,
  setLinkAskDraft,
  setLinkAskStatus,
} from "./link-ask";

/** Keeps what a person typed or ticked in a link ask card across repaints. */
export function rememberLinkAskDraft(target: EventTarget | null): void {
  if (!(target instanceof HTMLTextAreaElement) && !(target instanceof HTMLInputElement)) return;
  const review = target.closest<HTMLElement>("[data-visual-review-ask]")?.dataset[
    "visualReviewAsk"
  ];
  if (review && target instanceof HTMLTextAreaElement) {
    setLinkAskDraft(review, target.value);
    return;
  }
  const form = target.closest<HTMLFormElement>("[data-link-ask]");
  const id = form?.dataset["linkAsk"];
  if (!form || !id) return;
  if (target instanceof HTMLInputElement) {
    if (target.type === "checkbox") updateBypassButton(form, id);
    return;
  }
  const checkId = target.dataset["check"];
  if (checkId) setBypassReason(id, checkId, target.value);
  else setLinkAskDraft(id, target.value);
}

/** The checks ticked in a bypass card, each with the reason typed for it. */
function chosenBypasses(form: HTMLFormElement): { checkId: string; reason: string }[] {
  return [...form.querySelectorAll<HTMLInputElement>('input[name="check"]:checked')].map((box) => ({
    checkId: box.value,
    reason:
      [...form.querySelectorAll<HTMLTextAreaElement>('textarea[name="reason"]')]
        .find((field) => field.dataset["check"] === box.value)
        ?.value.trim() ?? "",
  }));
}

function updateBypassButton(form: HTMLFormElement, questionId: string): void {
  const chosen = chosenBypasses(form);
  setBypassSelection(
    questionId,
    chosen.map((entry) => entry.checkId),
  );
  const button = form.querySelector<HTMLButtonElement>("[data-bypass-submit]");
  if (!button) return;
  button.textContent = bypassLabel(chosen.length, form.dataset["bypass"] ?? "");
  button.disabled = chosen.length === 0 || linkAskPending(questionId);
}

/** Posts the decision with the CSRF token. Returns whether the event was a link ask form. */
export function submitLinkAsk(event: SubmitEvent, reload: () => Promise<void>): boolean {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || form.dataset["linkAsk"] === undefined) return false;
  event.preventDefault();
  const questionId = form.dataset["linkAsk"];
  if (linkAskPending(questionId)) return true;
  const decision = event.submitter instanceof HTMLButtonElement ? event.submitter.value : "approve";
  const note = form.querySelector<HTMLTextAreaElement>('textarea[name="note"]')?.value ?? "";
  const status = form.querySelector("[role=status]");
  const bypassing = form.dataset["bypass"] !== undefined && decision === "approve";
  const bypasses = bypassing ? chosenBypasses(form) : [];
  if (bypassing && (bypasses.length === 0 || bypasses.some((entry) => entry.reason === ""))) {
    const message =
      bypasses.length === 0
        ? "Select a failed check to bypass."
        : "Write why each selected check may be bypassed.";
    setLinkAskStatus(questionId, message, false);
    if (status) status.textContent = message;
    return true;
  }
  setLinkAskStatus(questionId, "Sending…", true);
  if (status) status.textContent = "Sending…";
  void (async () => {
    try {
      const response = await fetch("/api/link-asks", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-paws-csrf": readCsrfToken(document) },
        body: JSON.stringify({
          questionId,
          decision,
          note: bypassing ? "" : note,
          ...(bypassing ? { bypasses } : {}),
        }),
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

/** Stop in a link ask card stops the item, as the item's execution controls do. */
export function stopFromLinkAsk(event: MouseEvent, reload: () => Promise<void>): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const button = target.closest<HTMLButtonElement>("[data-link-ask-stop]");
  const form = button?.closest<HTMLFormElement>("[data-link-ask]");
  const itemId = button?.dataset["linkAskStop"];
  const questionId = form?.dataset["linkAsk"];
  if (!button || !itemId || !questionId) return false;
  if (linkAskPending(questionId)) return true;
  setLinkAskStatus(questionId, "Stopping…", true);
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
      setLinkAskStatus(questionId, "Item stopped.", false);
    } catch (error) {
      journalCaught(error, "link-ask.stop.fetch", null);
      setLinkAskStatus(
        questionId,
        error instanceof Error ? error.message : "The item was not stopped. Try again.",
        false,
      );
    }
    await reload();
  })();
  return true;
}
