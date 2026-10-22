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
  /** Repositories where GitHub requires branches to be up to date, as merges last read it. */
  upToDateRule?: string[];
};
