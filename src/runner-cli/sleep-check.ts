import { existsSync } from "node:fs";
import { join } from "node:path";
import { journalCaught } from "../journal";
import { heldCredentialsLeft } from "../runner-daemon";
import { activeExecutions, onTmpfs, runnerSignInsLeft } from "../runner-execution";
import { finishOpenCodePurge, openCodeCredentialLeft } from "../runner-worker";

export const ISSUE_VM_CREDENTIALS = "/run/paws-runner/credentials";

export function runnerSleepLeftovers(agentHome: string, credentials: string, issueVm = false) {
  const accounts = join(agentHome, ".paws-accounts");
  const left = runnerSignInsLeft(agentHome, (home) => {
    try {
      if (issueVm && !activeExecutions(home).length) finishOpenCodePurge(home);
      return openCodeCredentialLeft(home);
    } catch (error) {
      journalCaught(error, "runner-cli.sleepCheck.openCode", null);
      return true;
    }
  });
  const held = heldCredentialsLeft(credentials);
  if (held) left.push(`${held} held or pending sign-in uploads`);
  if (issueVm && held === null) left.push("runner credential store is not ready");
  if (issueVm && !(existsSync(accounts) && onTmpfs(accounts)))
    left.push("account homes are not on a tmpfs");
  return left;
}
