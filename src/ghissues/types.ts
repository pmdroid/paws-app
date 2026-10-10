/**
 * Matches the `GitHubTokenProvider` QM-24 exports from `src/auth`.
 * This module accepts one as a parameter and does not import `src/auth`.
 */
export type GitHubTokenProvider = {
  token(): Promise<string>;
  user(): Promise<{ login: string; id: number }>;
  source: "oauth" | "gh" | "app";
};

export type GitHubRepoRef = {
  owner: string;
  repo: string;
};

/**
 * Normalized `[tracker.github]`. `statusLabels` is the `status_labels` table;
 * applying those labels is left to the process that wires this client.
 */
export type GitHubTrackerConfig = {
  triggerLabel: string;
  mention: string;
  trusted: readonly string[];
  repos: readonly GitHubRepoRef[];
  statusLabels: Readonly<Record<string, string>>;
};

export type GitHubIssue = {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string | null;
  authorLogin: string | null;
  authorId: number | null;
  authorAssociation: string;
  labels: readonly string[];
  updatedAtMs: number;
  pullRequest: boolean;
};

export type GitHubComment = {
  id: number;
  owner: string;
  repo: string;
  number: number;
  body: string;
  authorLogin: string | null;
  authorId: number | null;
  authorAssociation: string;
  updatedAtMs: number;
  pullRequest: boolean;
};

export type GitHubRateSnapshot = {
  remaining: number | null;
  resetMs: number | null;
};

export type GitHubList<T> = {
  url: string;
  etag: string | null;
  notModified: boolean;
  items: readonly T[];
  rate: GitHubRateSnapshot;
};

/** Frozen `[tracker.github]` keys. Omitted fields use these defaults. */
export type GitHubTrackerInput = {
  trigger_label?: string;
  mention?: string;
  trusted?: readonly string[];
  repos?: readonly string[];
  status_labels?: Readonly<Record<string, string>>;
};

export const DEFAULT_TRIGGER_LABEL = "paws";
export const DEFAULT_MENTION = "@paws";
export const DEFAULT_TRUSTED = ["OWNER", "MEMBER", "COLLABORATOR"] as const;

export function githubTrackerConfig(input: GitHubTrackerInput = {}): GitHubTrackerConfig {
  const triggerLabel = requiredText(input.trigger_label, DEFAULT_TRIGGER_LABEL, "trigger_label");
  const mention = requiredText(input.mention, DEFAULT_MENTION, "mention");
  const trusted = [...(input.trusted ?? DEFAULT_TRUSTED)];
  if (trusted.some((role) => role.trim().length === 0)) {
    throw new Error("trusted associations must be non-empty");
  }
  return {
    triggerLabel,
    mention,
    trusted,
    repos: (input.repos ?? []).map(parseRepoSlug),
    statusLabels: stringRecord(input.status_labels),
  };
}

export function parseRepoSlug(value: string): GitHubRepoRef {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(value.trim());
  const owner = match?.[1];
  const repo = match?.[2];
  if (owner === undefined || repo === undefined) {
    throw new Error(`github repo must be owner/repo, got ${value}`);
  }
  return { owner, repo };
}

function requiredText(value: string | undefined, fallback: string, key: string): string {
  const text = (value ?? fallback).trim();
  if (text.length === 0) throw new Error(`${key} must not be empty`);
  return text;
}

function stringRecord(value: Readonly<Record<string, string>> | undefined): Record<string, string> {
  if (value === undefined) return {};
  const out: Record<string, string> = {};
  for (const [key, label] of Object.entries(value)) {
    if (typeof label !== "string" || label.trim().length === 0) {
      throw new Error(`status_labels.${key} must be a label name`);
    }
    out[key] = label;
  }
  return out;
}
