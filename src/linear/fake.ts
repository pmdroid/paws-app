import type { TrackerRequestOptions } from "./adapter";
import type { IssuePullRequest } from "./issue-pulls";
import type { LinearIssueContext } from "./issue-context";
import type { LinearSessionAdapter } from "./sessions";
import { activityInput, elicitationInput, validateSessionUpdate, validateUrls } from "./sessions";
import {
  authorizedRepositorySuggestions,
  repositoryCandidates,
  type LinearRepositoryAdapter,
  type RepositorySuggestion,
  type RepositorySuggestionsInput,
  type RepositoryHints,
  NO_REPOSITORY_HINTS,
} from "./repositories";
import type {
  DependencyEdge,
  IssueAttachment,
  SessionElicitation,
  EpicSnapshot,
  ProgressUpdate,
  SessionOnComment,
  SessionOnIssue,
  SessionUpdate,
  StatusUpdate,
} from "./types";

export type FakeTracker = LinearSessionAdapter &
  LinearRepositoryAdapter & {
    attachments: IssueAttachment[];
    issuePullRequests: Map<string, IssuePullRequest[]>;
    issueContexts: Map<string, LinearIssueContext>;
    repositorySuggestionRequests: RepositorySuggestionsInput[];
    repositorySuggestions: Map<string, readonly RepositorySuggestion[]>;
    repositoryHints: Map<string, RepositoryHints>;
    repositoryLabels: { issueId: string; repository: string }[];
    epics: Map<string, EpicSnapshot>;
    deps: Map<string, readonly DependencyEdge[]>;
    progress: ProgressUpdate[];
    questions: SessionElicitation[];
    statuses: StatusUpdate[];
    sessionUpdates: SessionUpdate[];
    issueSessions: SessionOnIssue[];
    commentSessions: SessionOnComment[];
  };

export function createFakeTracker(epics: readonly EpicSnapshot[] = []): FakeTracker {
  const attachments: IssueAttachment[] = [];
  const issuePullRequests = new Map<string, IssuePullRequest[]>();
  const issueContexts = new Map<string, LinearIssueContext>();
  const byId = new Map(epics.map((epic) => [epic.linearIssueId, epic]));
  const deps = new Map<string, readonly DependencyEdge[]>();
  const progress: ProgressUpdate[] = [];
  const questions: SessionElicitation[] = [];
  const statuses: StatusUpdate[] = [];
  const sessionUpdates: SessionUpdate[] = [];
  const issueSessions: SessionOnIssue[] = [];
  const commentSessions: SessionOnComment[] = [];
  const repositorySuggestionRequests: RepositorySuggestionsInput[] = [];
  const repositorySuggestions = new Map<string, readonly RepositorySuggestion[]>();
  const repositoryHints = new Map<string, RepositoryHints>();
  const repositoryLabels: { issueId: string; repository: string }[] = [];
  async function createActivity(update: ProgressUpdate, options?: TrackerRequestOptions) {
    options?.signal?.throwIfAborted();
    activityInput(update);
    progress.push(update);
    return { id: update.id ?? crypto.randomUUID() };
  }
  async function createElicitation(question: SessionElicitation, options?: TrackerRequestOptions) {
    options?.signal?.throwIfAborted();
    elicitationInput(question);
    questions.push(question);
    return { id: question.id ?? crypto.randomUUID() };
  }
  return {
    issuePullRequests,
    async listIssuePullRequests(id, options) {
      options?.signal?.throwIfAborted();
      return issuePullRequests.get(id) ?? [];
    },
    supportsActivityReconciliation: true,
    issueContexts,
    async getIssueContext(id, options) {
      options?.signal?.throwIfAborted();
      const context = issueContexts.get(id);
      if (!context) throw new Error("Missing fake Linear issue context");
      return context;
    },
    attachments,
    async createIssueAttachment(input, options) {
      options?.signal?.throwIfAborted();
      const existing = attachments.findIndex(
        (row) => row.id === input.id || (row.issueId === input.issueId && row.url === input.url),
      );
      if (existing < 0) attachments.push(input);
      else attachments[existing] = input;
    },
    epics: byId,
    deps,
    progress,
    questions,
    statuses,
    sessionUpdates,
    issueSessions,
    commentSessions,
    repositorySuggestionRequests,
    repositorySuggestions,
    repositoryHints,
    repositoryLabels,
    async addRepositoryLabel(input, options) {
      options?.signal?.throwIfAborted();
      repositoryLabels.push({ ...input });
    },
    async issueRepositoryHints(issueId, options) {
      options?.signal?.throwIfAborted();
      return repositoryHints.get(issueId) ?? NO_REPOSITORY_HINTS;
    },
    async issueRepositorySuggestions(input, options) {
      options?.signal?.throwIfAborted();
      const candidates = repositoryCandidates(input);
      if (candidates.length === 0) return [];
      repositorySuggestionRequests.push(structuredClone(input));
      return authorizedRepositorySuggestions(
        candidates,
        repositorySuggestions.get(input.issueId) ?? [],
      );
    },
    createActivity,
    createElicitation,
    async updateSession(update, options) {
      options?.signal?.throwIfAborted();
      validateSessionUpdate(update);
      sessionUpdates.push(update);
      return { id: update.sessionId };
    },
    async createSessionOnIssue(input, options) {
      options?.signal?.throwIfAborted();
      validateUrls(input.externalUrls);
      issueSessions.push(input);
      return { id: crypto.randomUUID() };
    },
    async createSessionOnComment(input, options) {
      options?.signal?.throwIfAborted();
      validateUrls(input.externalUrls);
      commentSessions.push(input);
      return { id: crypto.randomUUID() };
    },
    async loadEpic(linearIssueId) {
      const epic = byId.get(linearIssueId);
      if (epic === undefined) throw new Error(`unknown epic ${linearIssueId}`);
      return epic;
    },
    async listDeps(linearIssueId) {
      return deps.get(linearIssueId) ?? [];
    },
    async postProgress(update, options) {
      await createActivity(update, options);
    },
    async askQuestion(question, options) {
      await createElicitation(question, options);
    },
    async setStatus(update, options) {
      options?.signal?.throwIfAborted();
      statuses.push(update);
    },
  };
}
