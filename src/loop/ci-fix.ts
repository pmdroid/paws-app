/** Messages for a CI fix round: the agent handoff, the Linear line, and the question when attempts run out. */

export type FailedCiCheck = { name: string; url: string | null; logTail?: string | null };

export function ciFixHandoff(checks: readonly FailedCiCheck[]): string {
  return [
    "CI failed on the pull request. Failed checks:",
    ...checkList(checks),
    ...checks.flatMap((check) =>
      check.logTail ? ["", `Last lines of the log for ${check.name}:`, fenced(check.logTail)] : [],
    ),
    "",
    "Run the same checks in this repository to reproduce the failures, fix the code so the change still does what the issue asks, and run the checks again.",
  ].join("\n");
}

/** A code fence longer than any backtick run in the log, so the log cannot close it. */
function fenced(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
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
      ? "CI fix attempts are set to 0, so Paws did not send it back to the agent."
      : `The agent used all ${limit} CI fix ${limit === 1 ? "attempt" : "attempts"}.`;
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
