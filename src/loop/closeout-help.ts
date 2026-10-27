import type { Database } from "bun:sqlite";
import {
  getWorkItem,
  immediate,
  saveCheckpoint,
  saveCloseoutBypassChecks,
  saveCloseoutRecovery,
  type CloseoutRecovery,
} from "../db";
import type { RuleApproval } from "../closeout";
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
 *
 * With `rules`, the failed checks are rules set to `onFail: approve`: the link
 * ask is the `rule` kind, Approve accepts the break for this head with a
 * reason, and Send back or a reply in Linear hands the agent the finding.
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
    rules?: readonly RuleApproval[];
  },
): void {
  const rules = input.rules ?? [];
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
            kind: rules.length > 0 ? "rule" : "bypass",
            head: help.head,
            detail: rules.length > 0 ? ruleDetail(rules) : bypassDetail(help, input.error),
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
            ruleCheck(rules.find((rule) => rule.id === id)) ??
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

/**
 * A held rule as a stored check of its ask. The message is the finding a send
 * back hands the agent.
 */
function ruleCheck(rule: RuleApproval | undefined): CloseoutHelpCheck | undefined {
  return rule === undefined
    ? undefined
    : {
        id: rule.id,
        kind: "rule",
        state: "failed",
        ...(rule.attempt === undefined ? {} : { attempt: rule.attempt }),
        message: rule.feedback,
      };
}

/** The text under a rule ask's title, in Linear and on the card: each broken rule, its summary and the finding. */
function ruleDetail(rules: readonly RuleApproval[]): string {
  return [
    ...rules.map((rule) => `Rule ${rule.id} broke: ${rule.summary} Finding: ${rule.message}.`),
    "Approve the break for this commit with a reason, or send the finding back to the agent.",
  ].join("\n");
}
