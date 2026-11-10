import {
  latestMergeJobSummarySteps,
  getItemPullRequestSteps,
  getPullRequestTextSteps,
  getWorkItemSteps,
  savePullRequestTextSteps,
  type Db,
  type PullRequestDraft,
  type PullRequestText,
} from "../db";
import {
  publishedPullRequestBody,
  readPullRequestText,
  updatePullRequestText,
  type GitHubBinding,
} from "../github";
import { withLeftForLater } from "../core";

const CLOSED_STATES = new Set(["merged", "completed", "cancelled"]);

export async function applyPullRequestDraft(input: {
  store: Db;
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
  const { store } = input;
  const [pull, state] = await store.run(function* (q) {
    const row = yield* getItemPullRequestSteps(q, input.itemId);
    return [row, (yield* getWorkItemSteps(q, input.itemId))?.state] as const;
  });
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
    let written = await store.run((q) => getPullRequestTextSteps(q, input.itemId));
    if (written && sameText(written, input.issue, input.draft)) return "unchanged";
    const live = await readPullRequestText(target);
    if (input.stopped()) return "stopped";
    if (!live.open) return "no_pull";
    if (!written) {
      written = recoveredText(input.issue, live, [
        input.previous
          ? withLeftForLater(input.previous.body, input.previous.remaining ?? [])
          : undefined,
        await acceptedSummary(store, input.itemId),
      ]);
      const recovered = written;
      await store.run((q) => savePullRequestTextSteps(q, input.itemId, recovered, input.now));
      if (sameText(written, input.issue, input.draft)) return "unchanged";
    }
    const body = textBody(written, input.issue, input.draft);
    await updatePullRequestText({ ...target, title, body });
    if (input.stopped()) return "stopped";
    const saved = { ...written, title, body };
    await store.run((q) => savePullRequestTextSteps(q, input.itemId, saved, input.now));
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

async function acceptedSummary(store: Db, itemId: string): Promise<string | undefined> {
  return (await store.run((q) => latestMergeJobSummarySteps(q, itemId))) ?? undefined;
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
