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

function mono(id: string, detail = ""): string {
  return `<span class="mono">${esc(id)}</span>${detail ? ` <span class="muted">${esc(detail)}</span>` : ""}`;
}

function outcome(check: StatusCheck): string {
  return check.state === "passed" || letPass(check)
    ? "passed"
    : broke(check)
      ? "failed"
      : check.state;
}

export function closeoutOverview(
  verdict: StatusVerdict | undefined,
  risk: StatusItemRisk | null | undefined,
  questions: readonly StatusQuestion[],
): string {
  const asks = questions
    .filter(
      (question) =>
        question.kind === "exhausted" || CLOSEOUT_ASKS.has(question.linkAsk?.kind ?? ""),
    )
    .map((question): [string, string] => {
      const anchor = question.linkAsk ? LINK_ASK_ANCHORS[question.linkAsk.kind] : null;
      const title = esc(question.title);
      return ["Waiting on you", anchor ? `<a href="#${esc(anchor)}">${title}</a>` : title];
    });
  const riskRow: [string, string] = [
    "Risk",
    risk ? `${risk.tier ? `${esc(risk.tier)} · ` : ""}${riskReason(risk)}` : "Not classified",
  ];
  if (!verdict)
    return `<p class="text-sm" data-closeout-summary>Closeout hasn't run yet.</p>${blockerList(asks)}${risk ? rowList([riskRow]) : ""}`;
  const attempts = attemptsOf(verdict);
  const latest = attempts.at(-1)!;
  const kind = (wanted: string) => latest.checks.filter((check) => check.kind === wanted);
  const checks = latest.checks.filter((check) => check.kind !== "rule" && check.kind !== "review");
  const rules = kind("rule");
  const running = latest.checks.filter((check) => check.state === "running");
  const failing = checks.filter(broke);
  const findings = (verdict.reviews ?? []).flatMap(
    (review) => review.rounds.at(-1)?.findings.filter((finding) => !finding.preExisting) ?? [],
  );
  const reviews = [
    ...kind("review").map((check) => [check.id, outcome(check)]),
    ...(verdict.reviews ?? [])
      .filter((review) => !kind("review").some((check) => check.id === review.id))
      .map((review) => [
        review.id,
        review.rounds.at(-1)?.findings.some((finding) => finding.blocking) ? "failed" : "passed",
      ]),
  ];
  const summary = [
    `${DECISIONS[latest.decision]}${latest.headSha ? ` at ${latest.headSha.slice(0, 7)}` : ""} in round ${roundAttempt(attempts, latest)} of ${verdict.maxAttempts}`,
    plural(checks.length, "check"),
    plural(reviews.length, "review"),
    risk?.tier ? `${risk.tier} risk` : "",
    latest.decision === "running" && running.length
      ? `running ${running.map((check) => check.id).join(", ")}`
      : "",
  ].filter(Boolean);
  const blockers: Array<[string, string]> = [
    ...[...failing, ...kind("review").filter(broke)].map((check): [string, string] => [
      "Failed",
      mono(check.id, check.detail ?? ""),
    ]),
    ...findings
      .filter((finding) => finding.severity === "P0" || finding.severity === "P1")
      .map((finding): [string, string] => [
        `Open ${finding.severity}`,
        mono(finding.location, finding.explanation),
      ]),
    ...rules
      .filter(broke)
      .map((rule): [string, string] => [
        "Rule broke",
        mono(rule.id, rule.approval?.state === "waiting" ? "waiting for approval" : ""),
      ]),
    ...asks,
  ];
  const count = (state: string) => checks.filter((check) => check.state === state).length;
  return `<p class="text-sm font-medium" data-closeout-summary>${esc(summary.join(" · "))}</p>${blockerList(blockers)}${rowList(
    [
      [
        "Checks",
        `${counts(
          [
            [count("passed"), "passed"],
            [failing.length, "failed"],
            [count("skipped"), "kept"],
            [count("running"), "running"],
          ],
          "No checks recorded yet",
        )}${failing.length ? ` · failing ${failing.map((check) => mono(check.id)).join(", ")}` : ""}`,
      ],
      [
        "Reviews",
        reviews.length
          ? `${reviews.map(([id, state]) => `${mono(id!)} ${esc(state!)}`).join(", ")} · ${plural(findings.length, "open finding")}`
          : "No reviews",
      ],
      [
        "Rules",
        counts(
          [
            [rules.filter((rule) => rule.state === "passed" || letPass(rule)).length, "held"],
            [rules.filter(broke).length, "broke"],
          ],
          "No rules ran",
        ),
      ],
      riskRow,
    ],
  )}`;
}

function blockerList(blockers: ReadonlyArray<[string, string]>): string {
  if (!blockers.length) return "";
  return `<ul class="closeout-blockers flex min-w-0 flex-col gap-1" role="list" aria-label="Closeout blockers">${blockers.map(([label, detail]) => `<li data-closeout-blocker><b>${esc(label)}</b> ${detail}</li>`).join("")}</ul>`;
}

function rowList(rows: ReadonlyArray<[string, string]>): string {
  return `<dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">${rows.map(([term, value]) => `<dt class="text-muted-foreground">${term}</dt><dd class="m-0 [overflow-wrap:anywhere]" data-closeout-row="${term.toLowerCase()}">${value}</dd>`).join("")}</dl>`;
}
