import type {
  StatusCheck,
  StatusItemRisk,
  StatusQuestion,
  StatusVerdict,
  VerdictDecision,
} from "../contract";
import { attemptsOf, roundAttempt } from "./closeout";
import { esc } from "./format";
import { LINK_ASK_ANCHORS } from "./link-ask";
import { riskReason } from "./risk";

const DECISIONS: Record<VerdictDecision, string> = {
  accepted: "Accepted",
  rejected: "Failed",
  exhausted: "Exhausted",
  running: "Running",
  blocked: "Blocked",
};

const CLOSEOUT_ASKS = new Set(["bypass", "rule", "risk", "rounds"]);

function letPass(check: StatusCheck): boolean {
  return check.approval?.state === "approved" || check.approval?.state === "bypassed";
}

function broke(check: StatusCheck): boolean {
  return ["failed", "blocked", "exhausted"].includes(check.state) && !letPass(check);
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function counts(parts: ReadonlyArray<[number, string]>, empty: string): string {
  const shown = parts.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
  return shown.length ? shown.join(" · ") : empty;
}

function ids(checks: readonly StatusCheck[]): string {
  return checks.map((check) => `<span class="mono">${esc(check.id)}</span>`).join(", ");
}

export function closeoutOverview(
  verdict: StatusVerdict | undefined,
  risk: StatusItemRisk | null | undefined,
  questions: readonly StatusQuestion[],
): string {
  const waiting = questions.filter(
    (question) =>
      question.kind === "exhausted" ||
      (question.linkAsk !== undefined && CLOSEOUT_ASKS.has(question.linkAsk.kind)),
  );
  const asks = waiting.map((question) => {
    const anchor = question.linkAsk ? LINK_ASK_ANCHORS[question.linkAsk.kind] : null;
    const title = esc(question.title);
    return ["Waiting on you", anchor ? `<a href="#${esc(anchor)}">${title}</a>` : title] as const;
  });
  if (!verdict)
    return `<p class="text-sm" data-closeout-summary>Closeout hasn't run yet.</p>${blockerList(asks)}${riskRow(risk)}`;
  const attempts = attemptsOf(verdict);
  const latest = attempts.at(-1)!;
  const checks = latest.checks.filter((check) => check.kind !== "rule" && check.kind !== "review");
  const reviewChecks = latest.checks.filter((check) => check.kind === "review");
  const rules = latest.checks.filter((check) => check.kind === "rule");
  const running = latest.checks.filter((check) => check.state === "running");
  const failing = checks.filter(broke);
  const brokenRules = rules.filter(broke);
  const findings = (verdict.reviews ?? []).flatMap(
    (review) => review.rounds.at(-1)?.findings.filter((finding) => !finding.preExisting) ?? [],
  );
  const reviewStates = [
    ...reviewChecks.map(
      (check) =>
        [
          check.id,
          check.state === "passed" || letPass(check)
            ? "passed"
            : broke(check)
              ? "failed"
              : check.state,
        ] as const,
    ),
    ...(verdict.reviews ?? [])
      .filter((review) => !reviewChecks.some((check) => check.id === review.id))
      .map(
        (review) =>
          [
            review.id,
            review.rounds.at(-1)?.findings.some((finding) => finding.blocking)
              ? "failed"
              : "passed",
          ] as const,
      ),
  ];
  const summary = [
    `${DECISIONS[latest.decision]}${latest.headSha ? ` at ${latest.headSha.slice(0, 7)}` : ""} in round ${roundAttempt(attempts, latest)} of ${verdict.maxAttempts}`,
    plural(checks.length, "check"),
    plural(reviewStates.length, "review"),
    risk?.tier ? `${risk.tier} risk` : "",
    latest.decision === "running" && running.length
      ? `running ${running.map((check) => check.id).join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const blockers = [
    ...[...failing, ...reviewChecks.filter(broke)].map(
      (check) =>
        [
          "Failed",
          `<span class="mono">${esc(check.id)}</span>${check.detail ? ` <span class="muted">${esc(check.detail)}</span>` : ""}`,
        ] as const,
    ),
    ...findings
      .filter((finding) => finding.severity === "P0" || finding.severity === "P1")
      .map(
        (finding) =>
          [
            `Open ${finding.severity}`,
            `<span class="mono">${esc(finding.location)}</span> <span class="muted">${esc(finding.explanation)}</span>`,
          ] as const,
      ),
    ...brokenRules.map(
      (rule) =>
        [
          "Rule broke",
          `<span class="mono">${esc(rule.id)}</span>${rule.approval?.state === "waiting" ? ' <span class="muted">waiting for approval</span>' : ""}`,
        ] as const,
    ),
    ...asks,
  ];
  const rows: Array<[string, string]> = [
    [
      "Checks",
      `${counts(
        [
          [checks.filter((check) => check.state === "passed").length, "passed"],
          [failing.length, "failed"],
          [checks.filter((check) => check.state === "skipped").length, "kept"],
          [checks.filter((check) => check.state === "running").length, "running"],
        ],
        "No checks recorded yet",
      )}${failing.length ? ` · failing ${ids(failing)}` : ""}`,
    ],
    [
      "Reviews",
      reviewStates.length
        ? `${reviewStates.map(([id, state]) => `<span class="mono">${esc(id)}</span> ${esc(state)}`).join(", ")} · ${plural(findings.length, "open finding")}`
        : "No reviews",
    ],
    [
      "Rules",
      counts(
        [
          [rules.filter((rule) => rule.state === "passed" || letPass(rule)).length, "held"],
          [brokenRules.length, "broke"],
        ],
        "No rules ran",
      ),
    ],
  ];
  return `<p class="text-sm font-medium" data-closeout-summary>${esc(summary)}</p>${blockerList(blockers)}<dl class="closeout-rows grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">${rows.map(([term, value]) => `<dt class="text-muted-foreground">${term}</dt><dd class="m-0 [overflow-wrap:anywhere]" data-closeout-row="${term.toLowerCase()}">${value}</dd>`).join("")}${riskTerm(risk)}</dl>`;
}

function blockerList(blockers: ReadonlyArray<readonly [string, string]>): string {
  if (!blockers.length) return "";
  return `<ul class="closeout-blockers flex min-w-0 flex-col gap-1" role="list" aria-label="Closeout blockers">${blockers.map(([label, detail]) => `<li data-closeout-blocker><b>${esc(label)}</b> ${detail}</li>`).join("")}</ul>`;
}

function riskTerm(risk: StatusItemRisk | null | undefined): string {
  const value = risk
    ? `${risk.tier ? `${esc(risk.tier)} · ` : ""}${riskReason(risk)}`
    : "Not classified";
  return `<dt class="text-muted-foreground">Risk</dt><dd class="m-0 [overflow-wrap:anywhere]" data-closeout-row="risk">${value}</dd>`;
}

function riskRow(risk: StatusItemRisk | null | undefined): string {
  return risk
    ? `<dl class="closeout-rows grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">${riskTerm(risk)}</dl>`
    : "";
}
