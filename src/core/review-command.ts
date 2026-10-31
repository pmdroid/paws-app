const REVIEW_COMMAND_AGENTS = ["codex", "claude"] as const;
export type ReviewCommandAgent = (typeof REVIEW_COMMAND_AGENTS)[number];

export function supportsReviewCommand(agent: string): agent is ReviewCommandAgent {
  return REVIEW_COMMAND_AGENTS.some((supported) => supported === agent);
}
