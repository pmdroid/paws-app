import { existsSync } from "node:fs";
import { join } from "node:path";
import { heldCredentialsLeft } from "../runner-daemon";
import { onTmpfs, runnerSignInsLeft } from "../runner-execution";

export const ISSUE_VM_CREDENTIALS = "/run/paws-runner/credentials";

export function runnerSleepLeftovers(agentHome: string, credentials: string, issueVm = false) {
  const accounts = join(agentHome, ".paws-accounts");
  const left = runnerSignInsLeft(agentHome);
  const held = heldCredentialsLeft(credentials);
  if (held) left.push(`${held} held or pending sign-in uploads`);
  if (issueVm && held === null) left.push("runner credential store is not ready");
  if (issueVm && !(existsSync(accounts) && onTmpfs(accounts)))
    left.push("account homes are not on a tmpfs");
  return left;
}
