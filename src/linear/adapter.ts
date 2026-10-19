import type { LinearAttributionContext } from "./attribution";
import type { LinearIssueContext } from "./issue-context";
import type { LinearSessionSnapshot, LinearActivitySnapshot } from "./history";
import type {
  DependencyEdge,
  IssueAttachment,
  Elicitation,
  EpicSnapshot,
  ProgressUpdate,
  StatusUpdate,
  SessionUpdate,
  SessionReceipt,
} from "./types";
import type { LinearRepositoryAdapter } from "./repositories";
import type { LinearProjectSnapshot, ProjectOverview } from "./project-scope";
import type { IssuePullRequest } from "./issue-pulls";

export type TrackerRequestOptions = {
  signal?: AbortSignal;
  reconcile?: boolean;
  isCurrent?: () => boolean;
};

/**
 * Tracker port. Linear is the first implementation; later trackers use the same methods.
 * `onAnswer` is inbound (the webhook), not a call on this interface.
 */
export interface TrackerAdapter {
  loadProject?(id: string, options?: TrackerRequestOptions): Promise<LinearProjectSnapshot>;
  listIssuePullRequests?(id: string, options?: TrackerRequestOptions): Promise<IssuePullRequest[]>;
  getIssueAttribution?(
    id: string,
    options?: TrackerRequestOptions,
  ): Promise<LinearAttributionContext>;
  listProjectMembers?(id: string, options?: TrackerRequestOptions): Promise<readonly string[]>;
  getIssueContext?(id: string, options?: TrackerRequestOptions): Promise<LinearIssueContext>;
  createIssueAttachment?(input: IssueAttachment, options?: TrackerRequestOptions): Promise<void>;
  getSession?(id: string, options?: TrackerRequestOptions): Promise<LinearSessionSnapshot>;
  listSessionActivities?(
    id: string,
    options?: TrackerRequestOptions,
  ): Promise<readonly LinearActivitySnapshot[]>;
  issueRepositorySuggestions?: LinearRepositoryAdapter["issueRepositorySuggestions"];
  issueRepositoryHints?: LinearRepositoryAdapter["issueRepositoryHints"];
  projectOverview?(
    issueId: string,
    options?: TrackerRequestOptions,
  ): Promise<ProjectOverview | null>;
  addRepositoryLabel?: LinearRepositoryAdapter["addRepositoryLabel"];
  supportsActivityReconciliation?: true;
  loadEpic(linearIssueId: string): Promise<EpicSnapshot>;
  listDeps(linearIssueId: string): Promise<readonly DependencyEdge[]>;
  postProgress(update: ProgressUpdate, options?: TrackerRequestOptions): Promise<void>;
  askQuestion(question: Elicitation, options?: TrackerRequestOptions): Promise<void>;
  updateSession?(update: SessionUpdate, options?: TrackerRequestOptions): Promise<SessionReceipt>;
  setStatus(update: StatusUpdate, options?: TrackerRequestOptions): Promise<void>;
}
