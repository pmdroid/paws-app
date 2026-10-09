import type {
  DependencyEdge,
  Elicitation,
  EpicSnapshot,
  ProgressUpdate,
  StatusUpdate,
} from "./types";

/**
 * Tracker port. Linear is the first implementation; later trackers use the same methods.
 * `onAnswer` is inbound (the webhook), not a call on this interface.
 */
export interface TrackerAdapter {
  loadEpic(linearIssueId: string): Promise<EpicSnapshot>;
  listDeps(linearIssueId: string): Promise<readonly DependencyEdge[]>;
  postProgress(update: ProgressUpdate): Promise<void>;
  askQuestion(question: Elicitation): Promise<void>;
  setStatus(update: StatusUpdate): Promise<void>;
}
