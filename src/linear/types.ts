export type LinearSchedulingMetadata = {
  teamId?: string;
  projectId?: string | null;
  /** The Linear user who leads the issue's project, when the read included it. */
  projectLeadId?: string | null;
  assigneeId?: string | null;
  priority?: number;
};

export type LinearSubIssue = LinearSchedulingMetadata & {
  linearIssueId: string;
  identifier: string;
  title: string;
  description?: string | null;
  acceptanceCriteria?: string | null;
  stateType?: string | null;
  /** The issue's page in Linear, when the read included it. */
  url?: string | null;
};

export type EpicSnapshot = LinearSchedulingMetadata & {
  linearIssueId: string;
  identifier: string;
  title: string;
  description: string | null;
  acceptanceCriteria?: string | null;
  stateType?: string | null;
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
  id?: string;
  action?: ActionDetails;
  ephemeral?: boolean;
};

export type ActionDetails = {
  action: string;
  parameter: string;
  result?: string;
};

export type ActivityReceipt = { id: string };

export type SelectOption = { label?: string; value: string };

export type AuthSignal = {
  url: string;
  userId?: string;
  providerName?: string;
};

export type Elicitation = {
  sessionId: string;
  questionId?: string;
  body: string;
  id?: string;
  options?: readonly (string | SelectOption)[];
  auth?: AuthSignal;
};

export type SessionElicitation = Elicitation;

export type StatusUpdate = {
  linearIssueId: string;
  stateType: "started" | "completed" | "canceled";
};

export type SessionPlanStep = {
  content: string;
  status: "pending" | "inProgress" | "completed" | "canceled";
};

export type SessionUrl = { label: string; url: string };

export type SessionUpdate = {
  sessionId: string;
  plan?: readonly SessionPlanStep[];
  externalUrls?: readonly SessionUrl[];
  addedExternalUrls?: readonly SessionUrl[];
  removedExternalUrls?: readonly string[];
  summary?: string | null;
};

export type SessionOnIssue = {
  issueId: string;
  externalUrls?: readonly SessionUrl[];
};

export type SessionOnComment = {
  commentId: string;
  externalUrls?: readonly SessionUrl[];
};

export type SessionReceipt = { id: string };

export type IssueAttachment = { id: string; issueId: string; title: string; url: string };
