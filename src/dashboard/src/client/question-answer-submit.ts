import { journalCaught } from "../journal";
import { readCsrfToken } from "./csrf";
import {
  questionAnswerLocked,
  setQuestionAnswerDraft,
  setQuestionAnswerStatus,
} from "./question-answer";

export function rememberQuestionAnswerDraft(target: EventTarget | null): void {
  if (!(target instanceof HTMLTextAreaElement)) return;
  const id = target.closest<HTMLFormElement>("[data-question-answer]")?.dataset["questionAnswer"];
  if (id) setQuestionAnswerDraft(id, target.value);
}

function setControls(form: HTMLFormElement, disabled: boolean): void {
  for (const control of form.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>(
    "button, textarea",
  ))
    control.disabled = disabled;
}

export function submitQuestionAnswer(event: SubmitEvent, reload: () => Promise<void>): boolean {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || form.dataset["questionAnswer"] === undefined)
    return false;
  event.preventDefault();
  const questionId = form.dataset["questionAnswer"];
  if (questionAnswerLocked(questionId)) return true;
  const status = form.querySelector("[role=status]");
  const show = (message: string, lock: boolean) => {
    setQuestionAnswerStatus(questionId, message, lock);
    if (status) status.textContent = message;
  };
  const option =
    event.submitter instanceof HTMLButtonElement && event.submitter.name === "option"
      ? event.submitter.value
      : null;
  const answer = (
    option ??
    form.querySelector<HTMLTextAreaElement>('textarea[name="answer"]')?.value ??
    ""
  ).trim();
  if (answer === "") {
    show("Write an answer.", false);
    return true;
  }
  setControls(form, true);
  show("Sending…", true);
  void (async () => {
    try {
      const response = await fetch("/api/questions/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-paws-csrf": readCsrfToken(document) },
        body: JSON.stringify({ questionId, answer }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(
          typeof body === "object" && body && "error" in body && typeof body.error === "string"
            ? body.error
            : "The answer was not sent. Refresh and try again.",
        );
      setQuestionAnswerDraft(questionId, null);
      show("Answered", true);
    } catch (error) {
      journalCaught(error, "question-answer.submit.fetch", null);
      setControls(form, false);
      show(error instanceof Error ? error.message : "The answer was not sent. Try again.", false);
    }
    await reload();
  })();
  return true;
}
