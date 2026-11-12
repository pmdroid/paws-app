/** `GET /api/settings/merging`. The config module keeps the same shape. */
export type MergeOrder = "queue" | "ci-green" | "github-queue";
export type MainMoved = "overlap" | "green" | "ci" | "closeout";
export type MergeChoice = { order: MergeOrder; mainMoved: MainMoved };
export type MergeSettings = {
  autoApproveHighRisk?: boolean;
  default: MergeChoice;
  /** Replaces every repository's high-risk globs; a repository left out has none. */
  highRiskPaths?: { repository: string; paths: string[] }[];
  /**
   * How long Paws collects pull request comments and changes-requested reviews before it hands
   * them to the agent together. Missing from an engine without the setting; the page then leaves
   * it alone.
   */
  commentWait?: CommentWait;
  ignoredComments?: IgnoredComments[];
};
export type IgnoredComments = {
  repository: string;
  ignoreCommentBots: string[];
  ignoreCommentMarkers: string[];
};
export type CommentWait = { quietSeconds: number; maxWaitSeconds: number };

/**
 * One repository under High-risk paths: `paths` from Paws settings, and its own
 * `.paws/high-risk-paths` on the last fetched `origin/main`, which the page shows read-only.
 */
export type HighRiskRepository = {
  repository: string;
  paths: string[];
  file:
    | { state: "present"; commit: string; paths: string[] }
    | { state: "missing"; commit: string }
    | { state: "unavailable"; reason: string };
};
/**
 * A file that sent work back for a merge-queue conflict in the last 7 days. While a running or
 * merge-queue item changes it, a queued item that changes it too waits for that one to merge.
 */
export type HotFile = {
  repository: string;
  path: string;
  conflicts: number;
  /** Linear identifiers of the items the conflicts sent back. */
  items: string[];
  /** Current overlap holds on the file: `held` waits for `holder` to merge. */
  holds?: { held: string; holder: string }[];
};
export type MergeSettingsView = Omit<MergeSettings, "highRiskPaths"> & {
  /** Missing from an engine that does not list them; the page then leaves them alone. */
  highRiskRepositories?: HighRiskRepository[];
  /**
   * Configured repositories whose base branch has a GitHub merge queue. Null when Paws could not
   * check; missing from an engine that does not check.
   */
  githubQueue?: { repositories: string[] } | null;
  githubQueueError?: string;
  upToDateRule?: string[];
  /** Whether a high-risk pull request waits for an approval in Paws; `reason` says why not. */
  riskGate?: { on: boolean; reason?: string };
  /** Read-only. Missing from an engine that does not track them. */
  hotFiles?: HotFile[];
};
