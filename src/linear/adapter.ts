import type { LinearSessionSnapshot, LinearActivitySnapshot } from "./history";
import type {
  DependencyEdge,
  Elicitation,
  EpicSnapshot,
  ProgressUpdate,
  StatusUpdate,
} from "./types";

export type TrackerRequestOptions = { signal?: AbortSignal };

/**
 * Tracker port. Linear is the first implementation; later trackers use the same methods.
 * `onAnswer` is inbound (the webhook), not a call on this interface.
 */
export interface TrackerAdapter {
  getSession?(id: string, options?: TrackerRequestOptions): Promise<LinearSessionSnapshot>;
  listSessionActivities?(
    id: string,
    options?: TrackerRequestOptions,
  ): Promise<readonly LinearActivitySnapshot[]>;
  loadEpic(linearIssueId: string): Promise<EpicSnapshot>;
  listDeps(linearIssueId: string): Promise<readonly DependencyEdge[]>;
  postProgress(update: ProgressUpdate, options?: TrackerRequestOptions): Promise<void>;
  askQuestion(question: Elicitation, options?: TrackerRequestOptions): Promise<void>;
  setStatus(update: StatusUpdate, options?: TrackerRequestOptions): Promise<void>;
}
