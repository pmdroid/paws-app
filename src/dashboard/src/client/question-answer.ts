const drafts = new Map<string, string>();
const messages = new Map<string, string>();
const locked = new Set<string>();

export function questionAnswerDraft(questionId: string): string {
  return drafts.get(questionId) ?? "";
}

export function setQuestionAnswerDraft(questionId: string, answer: string | null): void {
  if (answer === null) drafts.delete(questionId);
  else drafts.set(questionId, answer);
}

export function questionAnswerMessage(questionId: string): string {
  return messages.get(questionId) ?? "";
}

export function questionAnswerLocked(questionId: string): boolean {
  return locked.has(questionId);
}

export function setQuestionAnswerStatus(questionId: string, message: string, lock: boolean): void {
  messages.set(questionId, message);
  if (lock) locked.add(questionId);
  else locked.delete(questionId);
}
