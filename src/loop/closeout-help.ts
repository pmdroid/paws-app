import type { Database } from "bun:sqlite";
import {
  applyWorkItemEvent,
  getWorkItem,
  immediate,
  saveCheckpoint,
  saveCloseoutRecovery,
  type CloseoutRecovery,
} from "../db";
import { ask } from "../questions";
import { recoveryQuestion } from "./closeout-recovery";

export type CloseoutHelp = Omit<CloseoutRecovery, "questionId" | "answer" | "answeredBy">;

export function askCloseoutHelp(
  db: Database,
  sessionId: string,
  help: CloseoutHelp,
  input: { now: number; error?: string },
): void {
  immediate(db, () => {
    const item = getWorkItem(db, help.itemId);
    if (!item || item.state === "cancelled") return;
    const { question } = ask(
      db,
      { itemId: item.id, runId: item.currentRunId, sessionId },
      "closeout-help",
      recoveryQuestion(help, input.error),
      { now: input.now },
    );
    saveCloseoutRecovery(db, { ...help, questionId: question.id });
    if (item.state !== "awaiting_input") applyWorkItemEvent(db, item.id, "blocking_question");
    saveCheckpoint(db, item.id, {
      phase: "awaiting_input",
      baseSha: help.base,
      wipCommit: help.head,
    });
  });
}
