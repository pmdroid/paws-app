import type { LinearSessionAdapter } from "./sessions";
import { activityInput, elicitationInput, validateSessionUpdate, validateUrls } from "./sessions";
import type {
  DependencyEdge,
  SessionElicitation,
  EpicSnapshot,
  ProgressUpdate,
  SessionOnComment,
  SessionOnIssue,
  SessionUpdate,
  StatusUpdate,
} from "./types";

export type FakeTracker = LinearSessionAdapter & {
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
  const byId = new Map(epics.map((epic) => [epic.linearIssueId, epic]));
  const deps = new Map<string, readonly DependencyEdge[]>();
  const progress: ProgressUpdate[] = [];
  const questions: SessionElicitation[] = [];
  const statuses: StatusUpdate[] = [];
  const sessionUpdates: SessionUpdate[] = [];
  const issueSessions: SessionOnIssue[] = [];
  const commentSessions: SessionOnComment[] = [];
  async function createActivity(update: ProgressUpdate) {
    activityInput(update);
    progress.push(update);
    return { id: update.id ?? crypto.randomUUID() };
  }
  async function createElicitation(question: SessionElicitation) {
    elicitationInput(question);
    questions.push(question);
    return { id: question.id ?? crypto.randomUUID() };
  }
  return {
    epics: byId,
    deps,
    progress,
    questions,
    statuses,
    sessionUpdates,
    issueSessions,
    commentSessions,
    createActivity,
    createElicitation,
    async updateSession(update) {
      validateSessionUpdate(update);
      sessionUpdates.push(update);
      return { id: update.sessionId };
    },
    async createSessionOnIssue(input) {
      validateUrls(input.externalUrls);
      issueSessions.push(input);
      return { id: crypto.randomUUID() };
    },
    async createSessionOnComment(input) {
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
    async postProgress(update) {
      await createActivity(update);
    },
    async askQuestion(question) {
      await createElicitation(question);
    },
    async setStatus(update) {
      statuses.push(update);
    },
  };
}
