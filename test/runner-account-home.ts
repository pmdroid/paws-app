import { chmodSync } from "node:fs";
import { markRunnerAccountSignedIn, openRunnerAccountHome } from "../src/runner-execution";
import type { RunnerAccount, RunnerCodingAgent } from "../src/runner-protocol";

export const RUNNER_ACCOUNT: RunnerAccount = {
  accountId: "01J00000000000000000000001",
  bindingId: "01J00000000000000000000002",
};

export function signInRunnerAccount(
  home: string,
  agent: RunnerCodingAgent,
  account: RunnerAccount = RUNNER_ACCOUNT,
): string {
  chmodSync(home, 0o700);
  const accountHome = openRunnerAccountHome(home, account, agent, { signIn: true });
  markRunnerAccountSignedIn(accountHome, account, agent);
  return accountHome;
}
