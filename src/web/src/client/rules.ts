import type { StatusCheck, StatusCloseoutAttempt, StatusVerdict } from "../contract";
import {
  checkAnchor,
  checkBody,
  checkMark,
  isOpen,
  shownAttempt,
  type CloseoutView,
} from "./closeout";
import { durationLabel, esc } from "./format";
import { bypassReason, LINK_ASK_ANSWERERS, linkAskMessage, linkAskPending } from "./link-ask";

/**
 * The repository rules of the shown Closeout attempt, apart from its checks: each rule's probe
 * hash, exit code, duration and result, the probe output when its row is open, the decision on a
 * failed rule, and the rules whose paths matched none of the change.
 */
export function renderRuleResults(
  verdict: StatusVerdict,
  view: CloseoutView,
  engineUrl: string | null,
): string {
  const attempt = shownAttempt(verdict, view);
  const rules = attempt.checks.filter((check) => check.kind === "rule");
  const skipped = attempt.skippedRules ?? [];
  if (rules.length === 0 && skipped.length === 0) return "";
  const passed = rules.filter((rule) => rule.state === "passed").length;
  const count = rules.length
    ? `<span class="muted">${passed} of ${rules.length} passed</span>`
    : "";
  const rows = rules.map((rule) => ruleRow(verdict, attempt, rule, view, engineUrl)).join("");
  const notMatched = skipped.length
    ? `<p class="rule-skipped"><span class="muted">Not run, no changed path matches:</span> ${skipped.map((id) => `<span class="mono">${esc(id)}</span>`).join(", ")}</p>`
    : "";
  return `<section class="closeout-section rules-section" aria-labelledby="rules-${esc(verdict.itemId)}"><div class="between"><h2 id="rules-${esc(verdict.itemId)}">Repository rules</h2>${count}</div><p class="muted">Probes from the Closeout policy on the base branch, run outside the candidate checkout.</p>${rows ? `<div class="check-list">${rows}</div>` : ""}${notMatched}</section>`;
}

/** The result a rule row shows: the decision on a failed rule wins over its state. */
export function ruleResult(rule: StatusCheck): { label: string; tone: string } {
  if (rule.approval?.state === "waiting") return { label: "Waiting for approval", tone: "warn" };
  if (rule.approval?.state === "approved") return { label: "Approved", tone: "passed" };
  if (rule.approval?.state === "bypassed") return { label: "Bypassed", tone: "warn" };
  switch (rule.state) {
    case "passed":
      return { label: "Passed", tone: "passed" };
    case "failed":
      return { label: rule.timedOut ? "Timed out" : "Failed", tone: "failed" };
    case "exhausted":
      return { label: "Out of attempts", tone: "failed" };
    case "blocked":
      return { label: "Blocked", tone: "failed" };
    case "running":
      return { label: "Running", tone: "now" };
    case "stopped":
      return { label: "Stopped", tone: "" };
    default:
      return { label: "Pending", tone: "" };
  }
}

function ruleRow(
  verdict: StatusVerdict,
  attempt: StatusCloseoutAttempt,
  rule: StatusCheck,
  view: CloseoutView,
  engineUrl: string | null,
): string {
  const open = isOpen(view, verdict.itemId, attempt.number, rule);
  const anchor = checkAnchor(attempt.number, rule.id, verdict.itemId);
  const result = ruleResult(rule);
  const hash = rule.probeSha256
    ? `<span class="mono muted check-command" title="${esc(rule.probeSha256)}">probe ${esc(shortHash(rule.probeSha256))}</span>`
    : '<span class="muted check-command">probe hash not recorded</span>';
  const meta = [
    typeof rule.exitCode === "number" ? `exit ${rule.exitCode}` : "",
    typeof rule.elapsedMs === "number" ? durationLabel(rule.elapsedMs) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const head = `<button class="chk${open ? " on" : ""}" type="button" data-action="toggle-check" data-item="${esc(verdict.itemId)}" data-attempt="${attempt.number}" data-check="${esc(rule.id)}" aria-expanded="${open}" aria-controls="${anchor}-out"><span class="ico ${esc(rule.state)}" aria-label="${esc(rule.state)}">${checkMark(rule.state)}</span><span class="mono check-name">${esc(rule.id)}</span>${hash}<span class="check-meta">${meta}</span><span class="tag ${result.tone}">${esc(result.label)}</span><span class="check-chevron" aria-hidden="true">${open ? "⌄" : "›"}</span></button>`;
  const body = open
    ? `<div class="check-detail" id="${anchor}-out">${checkBody(verdict, attempt, rule, view, engineUrl, {})}</div>`
    : "";
  return `<div class="check-row rule-row" id="${anchor}">${head}${decision(rule)}${body}</div>`;
}

/** Approve and Send back for a rule waiting on a person, or who decided it, why and for which commit. */
function decision(rule: StatusCheck): string {
  const approval = rule.approval;
  if (!approval) return "";
  const commit = `<span class="mono">${esc(approval.head.slice(0, 7))}</span>`;
  if (approval.state !== "waiting") {
    const verb = approval.state === "approved" ? "Approved" : "Bypassed";
    const by = approval.by ? ` by <b>${esc(approval.by)}</b>` : "";
    const reason = approval.reason
      ? `<div class="bypass-finding">${esc(approval.reason)}</div>`
      : "";
    return `<div class="rule-decision"><p>${verb}${by} for commit ${commit} only.</p>${reason}</div>`;
  }
  const id = approval.questionId;
  if (!id) return "";
  const busy = linkAskPending(id) ? ' disabled=""' : "";
  const field = `rule-reason-${esc(id)}-${esc(rule.id.replace(/[^A-Za-z0-9_-]/g, "_"))}`;
  return `<form class="rule-decision link-ask-form" data-link-ask="${esc(id)}" data-rule="${esc(rule.id)}"><label class="field" for="${field}"><span>Reason</span><span class="muted">Approve accepts this break for commit ${commit} only. Send back gives the reason to the agent.</span></label><textarea id="${field}" name="reason" data-check="${esc(rule.id)}" rows="2" maxlength="10000">${esc(bypassReason(id, rule.id))}</textarea><div class="row wrap"><button class="btn primary" type="submit" name="decision" value="approve"${busy}>Approve</button><button class="btn" type="submit" name="decision" value="changes"${busy}>Send back</button></div><p class="muted">${LINK_ASK_ANSWERERS} A reply in Linear never approves a rule.</p><p class="muted" role="status">${esc(linkAskMessage(id))}</p></form>`;
}

function shortHash(sha256: string): string {
  return sha256.replace(/^sha256:/, "").slice(0, 12);
}
