import {
  adoptRunnerRebase,
  githubHttpsUrl,
  rebaseOntoMain,
  type PullFacts,
  type RebaseResult,
  type SerialMergeInput,
} from "../github";
import { journal } from "../journal";

export const RUNNER_REBASE_PLACEMENT_MS = 10 * 60_000;

export type RunnerRebaseRequest = {
  itemId: string;
  repository: string;
  branch: string;
  head: string;
  main: string;
  committer: { name: string; email: string };
  placementWaitMs: number;
};

export type RunnerRebaseOutcome =
  | { outcome: "rebased"; head: string }
  | { outcome: "conflict"; files: string[] }
  | { outcome: "failed"; reason: string }
  | { outcome: "unplaced" };

export type RunnerRebase = (request: RunnerRebaseRequest) => Promise<RunnerRebaseOutcome>;

export async function rebaseOnRunner(
  lane: SerialMergeInput,
  input: { itemId: string; facts: PullFacts | null; runner: RunnerRebase | undefined },
): Promise<RebaseResult> {
  const { facts, runner } = input;
  const committer = committerOf(lane.commitEnv);
  if (!runner || !facts) return rebaseOntoMain(lane);
  if (!committer) {
    journal(`item ${lane.issue} rebases onto main on the control plane: no commit identity`);
    return rebaseOntoMain(lane);
  }
  const outcome = await runner({
    itemId: input.itemId,
    repository: lane.remoteUrl ?? githubHttpsUrl(lane.owner, lane.repo),
    branch: facts.branch,
    head: facts.head,
    main: facts.base,
    committer,
    placementWaitMs: RUNNER_REBASE_PLACEMENT_MS,
  });
  const stopped = (result: Omit<RebaseResult & { rebased: false }, "rebased">["result"]) => ({
    rebased: false as const,
    result,
  });
  switch (outcome.outcome) {
    case "unplaced":
      journal(
        `item ${lane.issue} rebases onto main on the control plane: no runner was eligible within ${RUNNER_REBASE_PLACEMENT_MS / 60_000} minutes`,
      );
      return rebaseOntoMain(lane);
    case "conflict":
      return stopped({
        merged: false,
        outcome: "conflict",
        branch: facts.branch,
        base: facts.base,
        message: "rebase conflict",
        ...(outcome.files.length > 0 ? { conflictFiles: outcome.files } : {}),
      });
    case "failed":
      journal(`item ${lane.issue} runner rebase failed: ${outcome.reason}`);
      return stopped({
        merged: false,
        outcome: "rebase_failed",
        branch: facts.branch,
        base: facts.base,
        message: "rebase failed",
      });
    case "rebased":
      return adoptRunnerRebase(lane, { main: facts.base, head: facts.head, newHead: outcome.head });
  }
}

function committerOf(
  env: Record<string, string> | undefined,
): RunnerRebaseRequest["committer"] | null {
  const name = env?.GIT_COMMITTER_NAME;
  const email = env?.GIT_COMMITTER_EMAIL;
  return name && email ? { name, email } : null;
}
