import type { Database } from "bun:sqlite";
import {
  getWorkItem,
  immediate,
  saveCheckpoint,
  saveCloseoutBypassChecks,
  saveCloseoutRecovery,
  savePolicyBlock,
  type CloseoutRecovery,
} from "../db";
import type { RuleApproval } from "../closeout";
import { shortCommit } from "../questions";
import { ask } from "./operations";
import { PREPARATION_FAILED, RETRY_CLOSEOUT, recoveryQuestion } from "./closeout-recovery";
import { askWithLink, linkAskAvailable } from "./link-ask";
import type { MainPolicyError } from "./policy-outage";

const RETRIES_BY_ITSELF =
  "Paws retries by itself once main's policy loads. You don't need to reply.";

function retryCloseoutOffered(
  help: CloseoutHelp,
  input: { reason?: string; checks?: readonly CloseoutHelpCheck[] },
): boolean {
  if (input.reason === "budget_spent" || input.reason === "rule_approval") return false;
  if (help.head === "" || help.summary.startsWith(PREPARATION_FAILED)) return false;
  return !(input.checks ?? []).some(
    (check) =>
      (check.kind === "evidence" && check.state !== "passed") ||
      ((check.state === "failed" || check.state === "exhausted") &&
        check.kind !== "setup" &&
        (check.kind === "review" || !/timed out|could not start|not judged/.test(check.message))),
  );
}

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
    policyBlock?: { repository: string; unreadable: MainPolicyError };
  },
): void {
  const rules = input.rules ?? [];
  immediate(db, () => {
    const item = getWorkItem(db, help.itemId);
    if (!item || item.state === "cancelled") return;
    const retry = retryCloseoutOffered(help, input);
    const block = retry ? input.policyBlock : undefined;
    const body = recoveryQuestion(help, input.error);
    const retryNote = `Choose ${RETRY_CLOSEOUT}, or reply retry, to run Closeout again on this head without the agent.`;
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
            retry ? [body, retryNote, ...(block ? [RETRIES_BY_ITSELF] : [])].join("\n\n") : body,
            {
              now: input.now,
              reason: input.reason ?? "closeout_help",
              ...(retry ? { options: [RETRY_CLOSEOUT] } : {}),
            },
          ).question;
    saveCloseoutRecovery(db, { ...help, questionId: question.id });
    if (block && question.kind === "closeout-help")
      savePolicyBlock(db, {
        questionId: question.id,
        itemId: item.id,
        repository: block.repository,
        cause: "policy_unreadable",
        error: block.unreadable.message,
        policyPath: block.unreadable.path,
        main: block.unreadable.main,
        changedBy: block.unreadable.commit,
        createdAt: input.now,
      });
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
