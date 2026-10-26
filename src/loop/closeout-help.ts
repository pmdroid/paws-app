import type { Database } from "bun:sqlite";
import {
  getWorkItem,
  immediate,
  saveCheckpoint,
  saveCloseoutBypassChecks,
  saveCloseoutRecovery,
  type CloseoutRecovery,
} from "../db";
import { shortCommit } from "../questions";
import { ask } from "./operations";
import { PREPARATION_FAILED, recoveryQuestion } from "./closeout-recovery";
import { askWithLink, linkAskAvailable } from "./link-ask";

export type CloseoutHelp = Omit<CloseoutRecovery, "questionId" | "answer" | "answeredBy">;

/** A check as Closeout judged it on the asked head. */
export type CloseoutHelpCheck = {
  id: string;
  kind: string;
  state: string;
  attempt?: number;
  message: string;
};

/**
 * Asks how to continue after Closeout stopped. With failed checks on a
 * candidate and a dashboard link a person can open, it is a link ask: the
 * delegator or the project lead bypasses checks on the item page, and a reply
 * in Linear is guidance. Otherwise a reply in Linear is the only answer, and
 * it is guidance too.
 */
export function askCloseoutHelp(
  db: Database,
  sessionId: string,
  help: CloseoutHelp,
  input: {
    now: number;
    error?: string;
    reason?: string;
    version?: number;
    publicUrl?: string | null;
    checks?: readonly CloseoutHelpCheck[];
  },
): void {
  immediate(db, () => {
    const item = getWorkItem(db, help.itemId);
    if (!item || item.state === "cancelled") return;
    const question =
      linkAskAvailable(input.publicUrl) &&
      help.failedChecks.length > 0 &&
      help.head !== "" &&
      !help.summary.startsWith(PREPARATION_FAILED)
        ? askWithLink(db, {
            item,
            runId: item.currentRunId,
            kind: "bypass",
            head: help.head,
            detail: bypassDetail(help, input.error),
            publicUrl: input.publicUrl,
            now: input.now,
            ...(input.version !== undefined ? { version: input.version } : {}),
          }).question
        : ask(
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
          ).question;
    saveCloseoutRecovery(db, { ...help, questionId: question.id });
    if (question.kind === "link")
      saveCloseoutBypassChecks(
        db,
        question.id,
        help.failedChecks.map(
          (id) =>
            input.checks?.find((check) => check.id === id) ?? {
              id,
              kind: "",
              state: "failed",
              message: "",
            },
        ),
      );
    saveCheckpoint(db, item.id, {
      phase: "awaiting_input",
      baseSha: help.base,
      wipCommit: help.head,
    });
  });
}

/** The Markdown under the link ask's title: which checks failed and what the person can do. */
function bypassDetail(help: CloseoutHelp, error: string | undefined): string {
  const count = help.failedChecks.length;
  return [
    ...(error ? [error] : []),
    `Closeout stopped on ${shortCommit(help.head)}: ${count === 1 ? "1 check" : `${count} checks`} failed (${help.failedChecks.join(", ")}).`,
    "Bypass a failed check for this commit with a reason, send the agent guidance, or stop.",
  ].join(" ");
}
