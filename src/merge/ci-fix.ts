/** Messages for a CI fix round: the agent handoff, the Linear line, and the question when attempts run out. */

export type FailedCiCheck = {
  name: string;
  url: string | null;
  logTail?: string | null;
  /** The same check also failed on main. */
  failsOnBase?: boolean;
};

export function ciFixHandoff(checks: readonly FailedCiCheck[]): string {
  return [
    "CI failed on the pull request. Failed checks:",
    ...checkList(checks),
    ...checks.flatMap(logSection),
    "Run the same checks in this repository to reproduce the failures, fix the code so the change still does what the issue asks, and run the checks again.",
  ].join("\n");
}

/** The end of a failing check's log, fenced so its text cannot close the block. */
function logSection(check: FailedCiCheck): string[] {
  if (!check.logTail) return [];
  const fence = "`".repeat(
    Math.max(3, ...[...check.logTail.matchAll(/`+/g)].map((run) => run[0].length + 1)),
  );
  return [
    "",
    `End of the \`${check.name.replaceAll("`", "'")}\` log:`,
    fence,
    check.logTail,
    fence,
    "",
  ];
}

/** One line per round, for example "CI: `check / test` failed. Sent back to the agent, fix 1 of 3." */
export function ciFixRoundLine(
  checks: readonly FailedCiCheck[],
  attempt: number,
  limit: number,
): string {
  return `CI: ${checkNames(checks)} failed. Sent back to the agent, fix ${attempt} of ${limit}.`;
}

export function ciFixQuestion(
  checks: readonly FailedCiCheck[],
  limit: number,
  pullUrl: string | null,
): string {
  const pull = pullUrl === null ? "the pull request" : `the pull request (${pullUrl})`;
  const spent =
    limit === 0
      ? "Fix rounds are set to 0, so Paws did not send it back to the agent."
      : `The agent used all ${limit} fix ${limit === 1 ? "round" : "rounds"} across Closeout, CI and review.`;
  return [
    `CI failed on ${pull}. ${spent}`,
    "",
    "Failing checks:",
    ...checkList(checks),
    "",
    "Reply with guidance to start one more fix round, or stop the task.",
  ].join("\n");
}

function checkList(checks: readonly FailedCiCheck[]): string[] {
  return checks.length === 0
    ? ["- unknown checks"]
    : checks.map((check) => `- ${check.name}${check.url ? ` (${check.url})` : ""}`);
}

function checkNames(checks: readonly FailedCiCheck[]): string {
  return checks.length === 0
    ? "a check"
    : checks.map((check) => `\`${check.name.replaceAll("`", "'")}\``).join(", ");
}
