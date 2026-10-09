import type { EpicState, WorkItemState } from "./states";

export type ItemId = string;
export type EpicId = string;
export type RunId = string;

export type RunKind = "plan" | "implement" | "fix" | "rebase" | "review";

export type RunStatus = "provisioning" | "active" | "ended" | "lost";

export type RiskTier = "low" | "medium" | "high";

/** Execution record for one delegated issue. Linear remains the source of the brief. */
export type WorkItem = {
  id: ItemId;
  epicId: EpicId;
  linearIssueId: string;
  linearIdentifier: string;
  title: string;
  state: WorkItemState;
  branchName: string;
  version: number;
};

/** Parent issue delegated to Paws. Sub-issues are human-written in the quick MVP. */
export type Epic = {
  id: EpicId;
  linearIssueId: string;
  linearIdentifier: string;
  title: string;
  state: EpicState;
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
