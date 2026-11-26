import { journalCaught } from "../journal";
import { heldCredentialsLeft } from "../runner-daemon";
import { activeExecutions, runnerSignInsLeft } from "../runner-execution";
import { openCodeCredentialLeft, purgeOpenCodeCredential } from "../runner-worker";

export const ISSUE_VM_CREDENTIALS = "/run/paws-runner/credentials";

export function runnerSleepLeftovers(agentHome: string, credentials: string, issueVm = false) {
  const left = runnerSignInsLeft(agentHome, (home) => {
    try {
      if (issueVm && openCodeCredentialLeft(home) && !activeExecutions(home).length)
        purgeOpenCodeCredential(home);
      return openCodeCredentialLeft(home);
    } catch (error) {
      journalCaught(error, "runner-cli.sleepCheck.openCode", null);
      return true;
    }
  });
  const held = heldCredentialsLeft(credentials);
  if (held > 0) left.push(`${held} held or pending sign-in uploads`);
  return left;
}
