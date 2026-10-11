export type LinearSubIssue = {
  linearIssueId: string;
  identifier: string;
  title: string;
  description?: string | null;
  acceptanceCriteria?: string | null;
};

export type EpicSnapshot = {
  linearIssueId: string;
  identifier: string;
  title: string;
  description: string | null;
  acceptanceCriteria?: string | null;
  subIssues: readonly LinearSubIssue[];
};

export type DependencyEdge = {
  blockerLinearIssueId: string;
  blockedLinearIssueId: string;
};

export type ActivityKind = "thought" | "action" | "elicitation" | "response" | "error";

export type ProgressUpdate = {
  sessionId: string;
  kind: ActivityKind;
  body: string;
};

export type Elicitation = {
  sessionId: string;
  questionId?: string;
  body: string;
  options?: readonly string[];
};

export type StatusUpdate = {
  linearIssueId: string;
  stateType: "started" | "completed" | "canceled";
};
