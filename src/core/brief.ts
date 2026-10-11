export type IssueBrief = {
  source: "linear" | "github";
  issueId: string;
  identifier: string;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
};

export type WorkBrief = {
  issue: IssueBrief;
  epic: IssueBrief | null;
};
