import type { FiledSubIssue } from "../core";
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
import type { ProjectOverview } from "./project-scope";
import type { IssuePullRequest } from "./issue-pulls";
import type { LinearMergeChoices, LinearMergeContext } from "./merge-context";
import type { SubIssueRequest } from "./sub-issues";
import type { BriefIssueRead } from "./brief-issue";
import type { FiledFindingIssue, FindingIssueRequest } from "./finding-issues";

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
  readBriefIssue?(
    identifier: string,
    options?: TrackerRequestOptions,
  ): Promise<BriefIssueRead | null>;
  listIssuePullRequests?(id: string, options?: TrackerRequestOptions): Promise<IssuePullRequest[]>;
  getIssueContext?(id: string, options?: TrackerRequestOptions): Promise<LinearIssueContext>;
  deleteIssueAttachment?(id: string, options?: TrackerRequestOptions): Promise<void>;
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
  /**
   * File approved drafts under the parent with `blocks` relations and the repository label.
   * Idempotent per `key`; returns the filed issues in draft order. Nothing is delegated.
   */
  createSubIssues?(
    request: SubIssueRequest,
    options?: TrackerRequestOptions,
  ): Promise<FiledSubIssue[]>;
  /**
   * File an issue from a pre-existing review finding next to the related issue, in Triage and
   * not delegated. Idempotent per `key`.
   */
  fileFindingIssue?(
    request: FindingIssueRequest,
    options?: TrackerRequestOptions,
  ): Promise<FiledFindingIssue>;
  /** The issue's project and labels, matched by Settings → Merging when a task starts. */
  issueMergeContext?(id: string, options?: TrackerRequestOptions): Promise<LinearMergeContext>;
  mergeChoices?(options?: TrackerRequestOptions): Promise<LinearMergeChoices>;
  supportsActivityReconciliation?: true;
  loadEpic(linearIssueId: string): Promise<EpicSnapshot>;
  listDeps(linearIssueId: string): Promise<readonly DependencyEdge[]>;
  postProgress(update: ProgressUpdate, options?: TrackerRequestOptions): Promise<void>;
  postProgressWithSession?(
    update: ProgressUpdate,
    session: SessionUpdate,
    options?: TrackerRequestOptions,
  ): Promise<void>;
  askQuestion(question: Elicitation, options?: TrackerRequestOptions): Promise<void>;
  updateSession?(update: SessionUpdate, options?: TrackerRequestOptions): Promise<SessionReceipt>;
  setStatus(update: StatusUpdate, options?: TrackerRequestOptions): Promise<void>;
}
