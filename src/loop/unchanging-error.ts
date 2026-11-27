import { UserFacingError } from "../core";

export const UNCHANGING_ERROR_REASON = "unchanging_error";
export const UNCHANGING_ERROR_RETRY = "Retry";
export const UNCHANGING_ERROR_STOP = "Stop";

const NO_RUNNER = /^No paired runner can run (\S+) for this issue right now: (.+)\. Check runner/;
const SIGNED_OUT = /^(agent not signed in|agent account sign-in needs repair)$/;
const ACCESS_DENIED =
  /authentication failed|repository not found|permission to \S+ denied|could not read username|returned error: 40[134]\b/i;

export function unchangingErrorQuestion(error: unknown, identifier: string): string | null {
  for (let current = error, depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return null;
    const found = signedOut(current) ?? accessDenied(current);
    if (found)
      return `${identifier} can't continue: ${found} Waiting won't change this. Fix it and choose Retry, or stop.`;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function signedOut(error: object): string | null {
  if (!(error instanceof UserFacingError)) return null;
  const match = NO_RUNNER.exec(error.message);
  if (!match) return null;
  const reasons = match[2]!.split(/[;,] /).map((part) => part.split(": ").at(-1)!.trim());
  if (!reasons.every((reason) => SIGNED_OUT.test(reason))) return null;
  return `no runner has a signed-in ${match[1]} account (${match[2]}). Sign the agent account in again in Settings › Agent accounts.`;
}

function accessDenied(error: object): string | null {
  const { name, stderr } = error as { name?: unknown; stderr?: unknown };
  if (name !== "GitError" || typeof stderr !== "string" || !ACCESS_DENIED.test(stderr)) return null;
  const line = stderr
    .split("\n")
    .find((entry) => ACCESS_DENIED.test(entry))!
    .trim();
  return `GitHub refused access to the repository (${line}). Check the GitHub App's repository access.`;
}

export function signedOutQuestion(identifier: string, agent: string, message: string): string {
  return `${identifier} can't continue: ${agent} reported its sign-in is missing or expired. ${message.trim()} Waiting won't change this. Choose Retry once it's signed in, or stop.`;
}
