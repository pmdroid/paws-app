import type { Database } from "bun:sqlite";
import {
  getItemPullRequest,
  getPullRequestText,
  getWorkItem,
  savePullRequestText,
  type PullRequestDraft,
  type PullRequestText,
} from "../db";
import {
  publishedPullRequestBody,
  readPullRequestText,
  updatePullRequestText,
  type GitHubBinding,
} from "../github";

const CLOSED_STATES = new Set(["merged", "completed", "cancelled"]);

export async function applyPullRequestDraft(input: {
  db: Database;
  itemId: string;
  issue: string;
  draft: PullRequestDraft;
  previous: PullRequestDraft | null;
  repository: { owner: string; repo: string } | null;
  github: GitHubBinding | null;
  now: number;
  status: (line: string) => void;
  journal?: (line: string) => void;
  stopped: () => boolean;
  signal?: AbortSignal;
}): Promise<"updated" | "unchanged" | "no_pull" | "failed" | "stopped"> {
  const pull = getItemPullRequest(input.db, input.itemId);
  const state = getWorkItem(input.db, input.itemId)?.state;
  if (!pull || !input.repository || !input.github || !state || CLOSED_STATES.has(state))
    return "no_pull";
  const { tokenProvider, ...app } = input.github;
  const target = {
    ...(tokenProvider ? { tokenProvider, client: app.client } : app),
    owner: input.repository.owner,
    repo: input.repository.repo,
    number: pull.pullNumber,
    ...(input.signal ? { signal: input.signal } : {}),
  };
  const title = input.draft.title;
  try {
    if (input.stopped()) return "stopped";
    let written = getPullRequestText(input.db, input.itemId);
    if (!written) {
      const live = await readPullRequestText(target);
      if (input.stopped()) return "stopped";
      if (!live.open) return "no_pull";
      written = recoveredText(input.issue, input.previous, live);
      savePullRequestText(input.db, input.itemId, written, input.now);
    }
    const body = publishedPullRequestBody({
      issue: input.issue,
      description: input.draft.body,
      evidence: written.evidence,
    });
    if (title === written.title && body === written.body) return "unchanged";
    await updatePullRequestText({ ...target, title, body });
    if (input.stopped()) return "stopped";
    savePullRequestText(input.db, input.itemId, { ...written, title, body }, input.now);
    return "updated";
  } catch (error) {
    if (input.signal?.aborted || input.stopped()) return "stopped";
    const reason = error instanceof Error ? error.message : String(error);
    input.status(`Couldn't update the pull request title: ${reason}`);
    input.journal?.(
      `pull-request-text item=${input.itemId} pull=${pull.pullNumber} failed error=${reason}`,
    );
    return "failed";
  }
}

function recoveredText(
  issue: string,
  previous: PullRequestDraft | null,
  live: { title: string; body: string },
): PullRequestText {
  const description = previous ? { description: previous.body } : {};
  const prefix = publishedPullRequestBody({ issue, ...description, evidence: "" }).trimEnd();
  const evidence = live.body.startsWith(prefix) ? live.body.slice(prefix.length).trim() : null;
  if (
    evidence === null ||
    publishedPullRequestBody({ issue, ...description, evidence }) !== live.body
  )
    throw new Error("its body no longer matches what Paws published");
  return { title: live.title, body: live.body, evidence };
}
