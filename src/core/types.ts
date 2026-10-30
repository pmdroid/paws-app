import type { GitCommitPolicy } from "./commit-policy";
import type { DelegationState, WorkItemState } from "./states";

export type ItemId = string;
export type DelegationId = string;
export type RunId = string;

export type RunKind = "plan" | "implement" | "fix" | "rebase" | "review" | "recheck";

export type RunStatus = "provisioning" | "active" | "ended" | "lost";

/** Execution record for one delegated issue. Linear remains the source of the brief. */
export type WorkItem = {
  id: ItemId;
  delegationId: DelegationId;
  linearIssueId: string;
  linearIdentifier: string;
  title: string;
  state: WorkItemState;
  branchName: string;
  version: number;
};

/** Parent issue delegated to Paws. Sub-issues are human-written in the quick MVP. */
export type Delegation = {
  id: DelegationId;
  linearIssueId: string;
  linearIdentifier: string;
  title: string;
  state: DelegationState;
  version: number;
};

/** One ACP session attempt on one work item. */
export type Run = {
  id: RunId;
  itemId: ItemId;
  kind: RunKind;
  agent: string;
  status: RunStatus;
};

/** Last place a run can resume. `merge_queue` means a merge was in progress. */
export type CheckpointPhase = "running" | "verifying" | "awaiting_input" | "merge_queue";

export type Checkpoint = {
  commitPolicy?: GitCommitPolicy;
  /**
   * The paths this run leaves out, fixed when the run starts: `agent` for the agent's checkout,
   * `checks` for Closeout and review. A later settings change applies to the next run.
   */
  checkout?: { agent: string[]; checks: string[] };
  resultBody?: string;
  phase: CheckpointPhase;
  wipCommit?: string;
  turn?: number;
  baseSha?: string;
  /**
   * The handoff naming commits that never reached GitHub, kept until a runner command carries it,
   * so a run that fails or a restart before dispatch still tells the agent what to redo.
   */
  lostCommits?: string;
};
