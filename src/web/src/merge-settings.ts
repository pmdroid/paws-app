/** `GET /api/settings/merging`. The config module keeps the same shape. */
export type MergeOrder = "queue" | "ci-green" | "github-queue";
export type MainMoved = "overlap" | "ci" | "closeout";
export type MergeChoice = { order: MergeOrder; mainMoved: MainMoved };
export type MergeProject = Partial<MergeChoice> & { id: string };
export type MergeRule = Partial<MergeChoice> & { project?: string; label: string };
export type MergeSettings = {
  default: MergeChoice;
  projects: MergeProject[];
  rules: MergeRule[];
};
export type MergeSettingsView = MergeSettings & {
  choices?: { projects: { id: string; name: string }[]; labels: string[] } | null;
  choicesError?: string;
  /**
   * Configured repositories whose base branch has a GitHub merge queue. Null when Paws could not
   * check; missing from an engine that does not check.
   */
  githubQueue?: { repositories: string[] } | null;
  githubQueueError?: string;
  upToDateRule?: string[];
};
