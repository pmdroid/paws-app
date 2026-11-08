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
import { JOB_KIND, withLeftForLater } from "../core";

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
    if (written && sameText(written, input.issue, input.draft)) return "unchanged";
    const live = await readPullRequestText(target);
    if (input.stopped()) return "stopped";
    if (!live.open) return "no_pull";
    if (!written) {
      written = recoveredText(input.issue, live, [
        input.previous
          ? withLeftForLater(input.previous.body, input.previous.remaining ?? [])
          : undefined,
        acceptedSummary(input.db, input.itemId),
      ]);
      savePullRequestText(input.db, input.itemId, written, input.now);
      if (sameText(written, input.issue, input.draft)) return "unchanged";
    }
    const body = textBody(written, input.issue, input.draft);
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

function textBody(written: PullRequestText, issue: string, draft: PullRequestDraft): string {
  return publishedPullRequestBody({
    issue,
    description: withLeftForLater(draft.body, draft.remaining ?? []),
    evidence: written.evidence,
  });
}

function sameText(written: PullRequestText, issue: string, draft: PullRequestDraft): boolean {
  return draft.title === written.title && textBody(written, issue, draft) === written.body;
}

function acceptedSummary(db: Database, itemId: string): string | undefined {
  return (
    db
      .query<{ summary: string | null }, [string, string]>(
        `SELECT json_extract(payload, '$.summary') AS summary FROM job
         WHERE queue = ? AND json_extract(payload, '$.itemId') = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(JOB_KIND.merge, itemId)?.summary ?? undefined
  );
}

function recoveredText(
  issue: string,
  live: { title: string; body: string },
  hints: readonly (string | undefined)[],
): PullRequestText {
  const head = publishedPullRequestBody({ issue, evidence: "" }).trimEnd();
  const rest = live.body.startsWith(`${head}\n\n`) ? live.body.slice(head.length + 2) : null;
  const trimmed = rest?.trim();
  if (trimmed)
    for (const evidence of candidateEvidence(trimmed, hints)) {
      const description = trimmed.slice(0, trimmed.length - evidence.length).trim();
      const rebuilt = publishedPullRequestBody({
        issue,
        ...(description ? { description } : {}),
        evidence,
      });
      if (rebuilt === live.body) return { title: live.title, body: live.body, evidence };
    }
  throw new Error("its body no longer matches what Paws published");
}

function* candidateEvidence(trimmed: string, hints: readonly (string | undefined)[]) {
  const [description, summary] = hints;
  if (description?.trim() && trimmed.startsWith(`${description.trim()}\n\n`))
    yield trimmed.slice(description.trim().length + 2).trim();
  const lead = summary?.trim();
  if (lead) {
    if (trimmed.startsWith(lead)) yield trimmed;
    const at = trimmed.indexOf(`\n\n${lead}`);
    if (at >= 0) yield trimmed.slice(at + 2);
  }
}
