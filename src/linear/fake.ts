import type { BriefIssueRead } from "./brief-issue";
import type { LinearMergeContext } from "./merge-context";
import type { TrackerRequestOptions } from "./adapter";
import type { IssuePullRequest } from "./issue-pulls";
import type { LinearIssueContext } from "./issue-context";
import type { FiledSubIssue } from "../core";
import type { ProjectOverview } from "./project-scope";
import { subIssueId, validateSubIssueRequest, type SubIssueRequest } from "./sub-issues";
import {
  findingIssueId,
  findingIssueState,
  REVIEW_FINDING_LABEL,
  validateFindingIssueRequest,
  type FiledFindingIssue,
  type FindingIssueRequest,
  type FindingIssueTeamState,
} from "./finding-issues";
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
  LinearSubIssue,
  ProgressUpdate,
  SessionOnComment,
  SessionOnIssue,
  SessionUpdate,
  StatusUpdate,
} from "./types";

export type FakeTracker = LinearSessionAdapter &
  LinearRepositoryAdapter & {
    systemAlerts: import("./system-alert").SystemAlert[];
    postSystemAlert(
      input: import("./system-alert").SystemAlert,
      options?: TrackerRequestOptions,
    ): Promise<void>;
    attachments: IssueAttachment[];
    issuePullRequests: Map<string, IssuePullRequest[]>;
    issueContexts: Map<string, LinearIssueContext>;
    repositorySuggestionRequests: RepositorySuggestionsInput[];
    repositorySuggestions: Map<string, readonly RepositorySuggestion[]>;
    repositoryHints: Map<string, RepositoryHints>;
    projectOverviews: Map<string, ProjectOverview>;
    projectOverview(
      issueId: string,
      options?: TrackerRequestOptions,
    ): Promise<ProjectOverview | null>;
    repositoryLabels: { issueId: string; repository: string }[];
    /** Every createSubIssues call, including retries, in order. */
    subIssueRequests: SubIssueRequest[];
    /** Filed sub-issues per parent; a retried key returns the same issues. */
    subIssues: Map<string, (FiledSubIssue & { key: string; blockedBy: readonly string[] })[]>;
    createSubIssues(
      request: SubIssueRequest,
      options?: TrackerRequestOptions,
    ): Promise<FiledSubIssue[]>;
    /** Team, project and workflow states of each issue a finding issue is filed next to. */
    findingIssueTargets: Map<
      string,
      { teamId: string; projectId: string | null; states: FindingIssueTeamState[] }
    >;
    /** Issue labels; filing a finding issue creates `review finding` in the team when missing. */
    labels: { id: string; name: string; teamId: string | null }[];
    /** Every fileFindingIssue call, including retries, in order. */
    findingIssueRequests: FindingIssueRequest[];
    /** Issues filed from findings, with what Linear would hold for each. */
    findingIssues: (FiledFindingIssue & {
      key: string;
      teamId: string;
      projectId: string | null;
      stateId: string | null;
      labelIds: string[];
      title: string;
      description: string;
      relations: { type: "related"; relatedIssueId: string }[];
    })[];
    /** Errors the next fileFindingIssue calls throw, first first. */
    findingIssueFailures: Error[];
    fileFindingIssue(
      request: FindingIssueRequest,
      options?: TrackerRequestOptions,
    ): Promise<FiledFindingIssue>;
    /** Project and labels per issue. A missing issue has neither. */
    mergeContexts: Map<string, LinearMergeContext>;
    issueMergeContext(id: string, options?: TrackerRequestOptions): Promise<LinearMergeContext>;
    epics: Map<string, EpicSnapshot>;
    /** Child issue id to parent issue id, for one brief preview read. */
    briefParents: Map<string, string>;
    /** Identifiers passed to `readBriefIssue`, in order. */
    briefReads: string[];
    readBriefIssue(
      identifier: string,
      options?: TrackerRequestOptions,
    ): Promise<BriefIssueRead | null>;
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
  const briefParents = new Map<string, string>();
  const briefReads: string[] = [];
  const deps = new Map<string, readonly DependencyEdge[]>();
  const systemAlerts: import("./system-alert").SystemAlert[] = [];
  const progress: ProgressUpdate[] = [];
  const questions: SessionElicitation[] = [];
  const statuses: StatusUpdate[] = [];
  const sessionUpdates: SessionUpdate[] = [];
  const issueSessions: SessionOnIssue[] = [];
  const commentSessions: SessionOnComment[] = [];
  const repositorySuggestionRequests: RepositorySuggestionsInput[] = [];
  const repositorySuggestions = new Map<string, readonly RepositorySuggestion[]>();
  const repositoryHints = new Map<string, RepositoryHints>();
  const projectOverviews = new Map<string, ProjectOverview>();
  const repositoryLabels: { issueId: string; repository: string }[] = [];
  const mergeContexts = new Map<string, LinearMergeContext>();
  const subIssueRequests: SubIssueRequest[] = [];
  const findingIssueTargets: FakeTracker["findingIssueTargets"] = new Map();
  const labels: FakeTracker["labels"] = [];
  const findingIssueRequests: FindingIssueRequest[] = [];
  const findingIssues: FakeTracker["findingIssues"] = [];
  const findingIssueFailures: Error[] = [];
  const subIssues = new Map<
    string,
    (FiledSubIssue & { key: string; blockedBy: readonly string[] })[]
  >();
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
    async deleteIssueAttachment(id, options) {
      options?.signal?.throwIfAborted();
      const index = attachments.findIndex((attachment) => attachment.id === id);
      if (index >= 0) attachments.splice(index, 1);
    },
    async createIssueAttachment(input, options) {
      options?.signal?.throwIfAborted();
      const existing = attachments.findIndex(
        (row) => row.id === input.id || (row.issueId === input.issueId && row.url === input.url),
      );
      if (existing < 0) attachments.push(input);
      else attachments[existing] = input;
    },
    epics: byId,
    briefParents,
    briefReads,
    async readBriefIssue(identifier, options) {
      options?.signal?.throwIfAborted();
      briefReads.push(identifier);
      const found = findBriefIssue(byId, identifier);
      if (found === undefined) return null;
      const parentId = briefParents.get(found.linearIssueId);
      const parent = parentId === undefined ? undefined : findBriefIssue(byId, parentId);
      const overview = projectOverviews.get(found.linearIssueId);
      return {
        issue: briefIssueFromSnapshot(found),
        parent: parent === undefined ? null : briefIssueFromSnapshot(parent),
        projectOverview:
          overview?.name && overview.content.trim()
            ? `Project overview: ${overview.name}\n\n${overview.content}`
            : "",
      };
    },
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
    mergeContexts,
    async issueMergeContext(issueId, options) {
      options?.signal?.throwIfAborted();
      return structuredClone({
        projectId: null,
        labels: [],
        overview: projectOverviews.get(issueId) ?? null,
        ...mergeContexts.get(issueId),
      });
    },
    projectOverviews,
    async projectOverview(issueId, options) {
      options?.signal?.throwIfAborted();
      return projectOverviews.get(issueId) ?? null;
    },
    async addRepositoryLabel(input, options) {
      options?.signal?.throwIfAborted();
      repositoryLabels.push({ ...input });
    },
    subIssueRequests,
    subIssues,
    async createSubIssues(request, options) {
      options?.signal?.throwIfAborted();
      const drafts = validateSubIssueRequest(request);
      subIssueRequests.push(structuredClone(request));
      const parent = byId.get(request.parentIssueId);
      const children = subIssues.get(request.parentIssueId) ?? [];
      subIssues.set(request.parentIssueId, children);
      const ids = drafts.map((_, index) => subIssueId(request.key, index));
      return drafts.map((draft, index) => {
        const existing = children.find((child) => child.id === ids[index]);
        if (existing)
          return { id: existing.id, identifier: existing.identifier, url: existing.url };
        const identifier = `${parent?.identifier ?? "FAKE"}-${children.length + 1}`;
        const filed = {
          id: ids[index]!,
          identifier,
          url: `https://linear.app/fake/issue/${identifier}`,
        };
        children.push({
          ...filed,
          key: request.key,
          blockedBy: draft.blockedBy.map((position) => ids[position]!),
        });
        if (request.repository)
          repositoryLabels.push({ issueId: filed.id, repository: request.repository });
        return filed;
      });
    },
    findingIssueTargets,
    labels,
    findingIssueRequests,
    findingIssues,
    findingIssueFailures,
    async fileFindingIssue(request, options) {
      options?.signal?.throwIfAborted();
      validateFindingIssueRequest(request);
      findingIssueRequests.push(structuredClone(request));
      const failure = findingIssueFailures.shift();
      if (failure) throw failure;
      const target = findingIssueTargets.get(request.relatedIssueId);
      if (!target) throw new Error("Linear returned no issue to file the finding by");
      const id = findingIssueId(request.key);
      const existing = findingIssues.find((issue) => issue.id === id);
      if (existing) return { id, identifier: existing.identifier, url: existing.url };
      let label = labels.find(
        (entry) =>
          entry.name.toLowerCase() === REVIEW_FINDING_LABEL &&
          (entry.teamId === target.teamId || entry.teamId === null),
      );
      if (!label) {
        label = { id: crypto.randomUUID(), name: REVIEW_FINDING_LABEL, teamId: target.teamId };
        labels.push(label);
      }
      const identifier = `FAKE-${findingIssues.length + 1}`;
      const filed = { id, identifier, url: `https://linear.app/fake/issue/${identifier}` };
      findingIssues.push({
        ...filed,
        key: request.key,
        teamId: target.teamId,
        projectId: target.projectId,
        stateId: findingIssueState(target.states),
        labelIds: [label.id],
        title: request.title,
        description: request.description,
        relations: [{ type: "related", relatedIssueId: request.relatedIssueId }],
      });
      return filed;
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
    systemAlerts,
    async postSystemAlert(input, options) {
      options?.signal?.throwIfAborted();
      const existing = systemAlerts.findIndex((alert) => alert.id === input.id);
      if (existing < 0) systemAlerts.push(input);
      else systemAlerts[existing] = input;
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

function findBriefIssue(
  epics: Map<string, EpicSnapshot>,
  idOrIdentifier: string,
): EpicSnapshot | LinearSubIssue | undefined {
  for (const epic of epics.values()) {
    if (epic.linearIssueId === idOrIdentifier || epic.identifier === idOrIdentifier) return epic;
    const child = epic.subIssues.find(
      (issue) => issue.linearIssueId === idOrIdentifier || issue.identifier === idOrIdentifier,
    );
    if (child) return child;
  }
  return undefined;
}

function briefIssueFromSnapshot(issue: EpicSnapshot | LinearSubIssue): BriefIssueRead["issue"] {
  return {
    source: "linear",
    issueId: issue.linearIssueId,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? null,
    acceptanceCriteria: issue.acceptanceCriteria ?? null,
  };
}
