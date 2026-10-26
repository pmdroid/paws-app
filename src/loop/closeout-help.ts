import type { Database } from "bun:sqlite";
import {
  getWorkItem,
  immediate,
  saveCheckpoint,
  saveCloseoutRecovery,
  type CloseoutRecovery,
} from "../db";
import { ask } from "./operations";
import { recoveryQuestion } from "./closeout-recovery";

export type CloseoutHelp = Omit<CloseoutRecovery, "questionId" | "answer" | "answeredBy">;

export function askCloseoutHelp(
  db: Database,
  sessionId: string,
  help: CloseoutHelp,
  input: { now: number; error?: string; reason?: string; version?: number },
): void {
  immediate(db, () => {
    const item = getWorkItem(db, help.itemId);
    if (!item || item.state === "cancelled") return;
    const { question } = ask(
      db,
      {
        itemId: item.id,
        runId: item.currentRunId,
        sessionId,
        ...(input.version !== undefined ? { version: input.version } : {}),
      },
      "closeout-help",
      recoveryQuestion(help, input.error),
      { now: input.now, reason: input.reason ?? "closeout_help" },
    );
    saveCloseoutRecovery(db, { ...help, questionId: question.id });
    saveCheckpoint(db, item.id, {
      phase: "awaiting_input",
      baseSha: help.base,
      wipCommit: help.head,
    });
  });
}
