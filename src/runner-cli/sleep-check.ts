import { journalCaught } from "../journal";
import { heldCredentialsLeft } from "../runner-daemon";
import { runnerSignInsLeft } from "../runner-execution";
import { openCodeCredentialLeft } from "../runner-worker";

export const ISSUE_VM_CREDENTIALS = "/run/paws-runner/credentials";

export function runnerSleepLeftovers(agentHome: string, credentials: string): string[] {
  const left = runnerSignInsLeft(agentHome, (home) => {
    try {
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
