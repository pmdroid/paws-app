import type { Database } from "bun:sqlite";
import {
  getItemPullRequest,
  getPullRequestText,
  getWorkItem,
  savePullRequestText,
  type PullRequestDraft,
} from "../db";
import { publishedPullRequestBody, updatePullRequestText, type GitHubBinding } from "../github";

const CLOSED_STATES = new Set(["merged", "completed", "cancelled"]);

export async function applyPullRequestDraft(input: {
  db: Database;
  itemId: string;
  issue: string;
  draft: PullRequestDraft;
  repository: { owner: string; repo: string } | null;
  github: GitHubBinding | null;
  now: number;
  status: (line: string) => void;
  journal?: (line: string) => void;
  signal?: AbortSignal;
}): Promise<"updated" | "unchanged" | "no_pull" | "failed"> {
  const pull = getItemPullRequest(input.db, input.itemId);
  const written = getPullRequestText(input.db, input.itemId);
  const state = getWorkItem(input.db, input.itemId)?.state;
  if (!pull || !written || !input.repository || !input.github || !state || CLOSED_STATES.has(state))
    return "no_pull";
  const title = input.draft.title;
  const body = publishedPullRequestBody({
    issue: input.issue,
    description: input.draft.body,
    evidence: written.evidence,
  });
  if (title === written.title && body === written.body) return "unchanged";
  try {
    const { tokenProvider, ...app } = input.github;
    await updatePullRequestText({
      ...(tokenProvider ? { tokenProvider, client: app.client } : app),
      owner: input.repository.owner,
      repo: input.repository.repo,
      number: pull.pullNumber,
      title,
      body,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    input.status(`Couldn't update the pull request title: ${reason}`);
    input.journal?.(
      `pull-request-text item=${input.itemId} pull=${pull.pullNumber} failed error=${reason}`,
    );
    return "failed";
  }
  savePullRequestText(input.db, input.itemId, { ...written, title, body }, input.now);
  return "updated";
}
