import type { TrackerAdapter } from "./adapter";
import type {
  DependencyEdge,
  Elicitation,
  EpicSnapshot,
  ProgressUpdate,
  StatusUpdate,
} from "./types";

export type FakeTracker = TrackerAdapter & {
  epics: Map<string, EpicSnapshot>;
  deps: Map<string, readonly DependencyEdge[]>;
  progress: ProgressUpdate[];
  questions: Elicitation[];
  statuses: StatusUpdate[];
};

export function createFakeTracker(epics: readonly EpicSnapshot[] = []): FakeTracker {
  const byId = new Map(epics.map((epic) => [epic.linearIssueId, epic]));
  const deps = new Map<string, readonly DependencyEdge[]>();
  const progress: ProgressUpdate[] = [];
  const questions: Elicitation[] = [];
  const statuses: StatusUpdate[] = [];
  return {
    epics: byId,
    deps,
    progress,
    questions,
    statuses,
    async loadEpic(linearIssueId) {
      const epic = byId.get(linearIssueId);
      if (epic === undefined) throw new Error(`unknown epic ${linearIssueId}`);
      return epic;
    },
    async listDeps(linearIssueId) {
      return deps.get(linearIssueId) ?? [];
    },
    async postProgress(update) {
      progress.push(update);
    },
    async askQuestion(question) {
      questions.push(question);
    },
    async setStatus(update) {
      statuses.push(update);
    },
  };
}
