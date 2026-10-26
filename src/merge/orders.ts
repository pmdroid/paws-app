import type { ask } from "../questions";
import type { Database } from "bun:sqlite";
import { mergeQueueLine, type RepositoryBinding } from "../core";
import {
  artifactPublicationReady,
  getWorkItem,
  joinMergeQueue,
  leaveMergeQueue,
  markMergeQueueNotified,
  mergeQueuePosition,
  recordCiRound,
  recordConfirmedRemoteMerge,
  recordRebaseReturn,
  type CiRound,
  type CiRoundCheck,
  type WorkItemRecord,
} from "../db";
import { githubQueueLine, githubQueueMerge, readPullReview, type GitHubBinding } from "../github";
import { ciFixHandoff, ciFixQuestion, ciFixRoundLine, type FailedCiCheck } from "./ci-fix";
import type { RebaseConflict } from "./budget";
import { askMergeHelp, rebaseBudgetFor, returnToAgent, type MergeReturnReason } from "./returns";
import type { MergeStep } from "./step";
import { githubQueueWatch, type MergeWait } from "./wait";

export const REBASE_CONFLICT_INSTRUCTION =
  "The pull request no longer rebases cleanly onto main. Paws already fetched main into origin/main in your checkout. Rebase this branch onto origin/main without fetching again and without a merge commit, resolve every conflict so the change still does what the issue asks, and run the checks again.";
export const REBASE_CONFLICT_THOUGHT =
  "Main moved and the branch conflicts. Sent it back to the agent to rebase.";
const CI_FIX_SOURCE = {
  pull: "The pull request's own checks failed before Paws could add it to the GitHub merge queue.",
  queue:
    "GitHub's merge queue removed the pull request because a check failed on the combined commit it tested with the pull requests ahead of it. Main may have changed since this branch was made.",
};

export type MergeVoice = {
  thought(item: WorkItemRecord, body: string, key: string): void;
  status(item: WorkItemRecord, body: string, key: string): void;
  afterPullRequest(item: WorkItemRecord, body: string, key: string): void;
  flush(): Promise<void>;
};

export type OrderCapabilities = {
  ask: typeof ask;
  now(): number;
  stopped(): boolean;
  session(item: WorkItemRecord): string | null;
  /** Fetch main into the item's worktree. Main's commit, or null without a worktree. */
  fetchMain(item: WorkItemRecord): Promise<string | null>;
  ciFixAttempts(item: WorkItemRecord): number;
  voice: MergeVoice;
};

export type MergeContext = {
  db: Database;
  item: WorkItemRecord;
  caps: OrderCapabilities;
};

export type MergePull = {
  github: GitHubBinding;
  repository: RepositoryBinding;
  pull: { number: number; url: string | null };
  head: string;
  signal: AbortSignal;
};

export function sendBack(
  { db, item, caps }: MergeContext,
  reason: MergeReturnReason,
  admit: (returns: number) => boolean,
  handoff: string,
  report: {
    thought: (attempt: number) => string;
    record: (jobId: number, attempt: number) => void;
  },
): boolean {
  return returnToAgent(db, {
    itemId: item.id,
    reason,
    admit,
    handoff,
    now: caps.now(),
    record: report.record,
    announce: (running, attempt, key) => {
      if (reason === "ci-failed") caps.voice.status(running, report.thought(attempt), key);
      else caps.voice.thought(running, report.thought(attempt), key);
    },
  });
}

export function askHelp(
  { db, item, caps }: MergeContext,
  body: string,
  reason = "merge_help",
): boolean {
  return askMergeHelp(db, {
    itemId: item.id,
    body,
    reason,
    now: caps.now(),
    session: caps.session,
    ask: caps.ask,
  });
}

export function ciRound(
  { db, item, caps }: MergeContext,
  head: string,
  checks: readonly CiRoundCheck[] | undefined,
  next: CiRound["next"],
  limit: number,
  fix: number | null,
): void {
  recordCiRound(db, {
    itemId: item.id,
    head,
    runId: getWorkItem(db, item.id)?.currentRunId ?? item.currentRunId,
    next,
    fix,
    fixLimit: limit,
    checks: [...(checks ?? [])],
    recordedAt: caps.now(),
  });
}

export async function mergeQueueTurn(
  { db, item, caps }: MergeContext,
  repository: { owner: string; repo: string },
  github: GitHubBinding,
  pull: { number: number; head: string },
): Promise<MergeWait | undefined> {
  const prNumber = pull.number;
  const name = `${repository.owner}/${repository.repo}`;
  const review = await readPullReview({
    client: github.client,
    owner: repository.owner,
    repo: repository.repo,
    prNumber,
    ...credentials(github),
  });
  if (caps.stopped()) return undefined;
  if (review === "unreadable" && mergeQueuePosition(db, item.id) === null)
    return {
      message: "Could not read the pull request's reviews.",
      queued: true,
      reason: "review",
    };
  if (review === "required" || review === "changes_requested") {
    leaveMergeQueue(db, item.id);
    const body =
      review === "required"
        ? `Waiting for an approving review on pull request #${prNumber}. It joins the ${name} merge queue once approved.`
        : `Changes were requested on pull request #${prNumber}. It joins the ${name} merge queue once approved.`;
    caps.voice.afterPullRequest(item, body, `${item.id}:merge-review:${review}:${pull.head}`);
    return { message: body, queued: true, reason: "review" };
  }
  joinMergeQueue(db, { itemId: item.id, repository: name, now: caps.now() });
  const place = mergeQueuePosition(db, item.id);
  if (place === null) return undefined;
  if (
    place.notifiedPosition !== place.position &&
    (place.position > 1 || place.notifiedPosition !== null)
  ) {
    const ahead = place.aheadItemId ? getWorkItem(db, place.aheadItemId) : null;
    const line = mergeQueueLine(place);
    const body =
      place.position === 1
        ? `${line}. Merging next.`
        : `${line}. ${ahead?.linearIdentifier ?? "The task ahead"} merges first.`;
    caps.voice.status(item, body, `${item.id}:merge-queue:${place.readyAt}:${place.position}`);
    markMergeQueueNotified(db, item.id, place.position);
  }
  if (place.position === 1) return undefined;
  const ahead = place.aheadItemId ? getWorkItem(db, place.aheadItemId) : null;
  return {
    message: `${mergeQueueLine(place)}. ${ahead?.linearIdentifier ?? "The task ahead"} merges first.`,
    queued: true,
    reason: "ahead",
  };
}

export async function mergeThroughGitHubQueue(
  merge: MergeContext,
  payload: unknown,
  published: MergePull,
): Promise<MergeStep | "no_queue"> {
  const { db, item, caps } = merge;
  const { repository, github, pull, head } = published;
  const name = `${repository.owner}/${repository.repo}`;
  const watch = githubQueueWatch(payload) ?? { queued: false };
  const result = await githubQueueMerge({
    owner: repository.owner,
    repo: repository.repo,
    prNumber: pull.number,
    head,
    client: github.client,
    appId: github.appId,
    installationId: github.installationId,
    privateKeyPem: github.privateKeyPem,
    ...(github.tokenProvider ? { tokenProvider: github.tokenProvider } : {}),
    queued: watch.queued,
    isCancelled: () => caps.stopped() || !artifactPublicationReady(db, item.id),
    signal: published.signal,
  });
  if (caps.stopped()) return { kind: "obsolete" };
  switch (result.outcome) {
    case "no_queue":
      caps.voice.status(
        item,
        `${result.message} Paws merges the pull request itself when its CI is green.`,
        `${item.id}:github-queue:none:${head}`,
      );
      return "no_queue";
    case "checks_pending":
    case "unreadable":
      return { kind: "wait", message: result.message, head, reason: "ci", githubQueue: watch };
    case "queued": {
      const line = githubQueueLine(name, result.position, result.state);
      if (!watch.queued)
        caps.voice.status(
          item,
          `Added ${pull.url ?? `pull request #${pull.number}`} to the GitHub merge queue. ${line}`,
          `${item.id}:github-queue:added:${head}`,
        );
      else if (watch.position !== result.position || watch.state !== result.state)
        caps.voice.status(
          item,
          line,
          `${item.id}:github-queue:${head}:${result.position}:${result.state}`,
        );
      await caps.voice.flush();
      return {
        kind: "wait",
        message: line,
        head,
        reason: (result.position ?? 1) > 1 ? "ahead" : "ci",
        githubQueue: { queued: true, position: result.position, state: result.state, line },
      };
    }
    case "merged":
      recordConfirmedRemoteMerge(db, {
        itemId: item.id,
        repositoryOwner: repository.owner,
        repositoryName: repository.repo,
        pullNumber: pull.number,
        pullUrl: pull.url,
        mergeSha: result.sha,
        confirmedAt: caps.now(),
      });
      return { kind: "merged" };
    case "ci_failed":
      return githubQueueCiFailed(merge, head, result.failedChecks, pull.url, CI_FIX_SOURCE.pull);
    case "removed": {
      const { removal } = result;
      const why = removal.reason ? ` (${removal.reason})` : "";
      if (removal.cause === "failed")
        return githubQueueCiFailed(
          merge,
          head,
          [{ name: removal.reason || "merge queue checks", url: pull.url }],
          pull.url,
          CI_FIX_SOURCE.queue,
        );
      if (removal.cause === "conflict") {
        const base = await caps.fetchMain(item).catch(() => null);
        const conflict: RebaseConflict = { base, files: null };
        const budget = rebaseBudgetFor(db, item.id, conflict, caps.now());
        if (
          base !== null &&
          sendBack(
            merge,
            "rebase-conflict",
            () => rebaseBudgetFor(db, item.id, conflict, caps.now()).allowed,
            REBASE_CONFLICT_INSTRUCTION,
            {
              thought: () =>
                `GitHub's merge queue removed the pull request for a conflict${why}. Sent it back to the agent to rebase.`,
              record: (jobId) =>
                recordRebaseReturn(db, {
                  itemId: item.id,
                  jobId,
                  candidate: head,
                  reason: "github_queue",
                  ...conflict,
                  recordedAt: caps.now(),
                }),
            },
          )
        )
          return { kind: "returned" };
        const message = `GitHub's merge queue removed the pull request for a conflict${why}.${budget.allowed ? "" : ` ${budget.message}`}`;
        if (
          askHelp(
            merge,
            `${message} Reply with guidance to continue, or stop the task.`,
            budget.allowed ? "merge_help" : "rebase_budget_spent",
          )
        ) {
          await caps.voice.flush();
          return { kind: "asked" };
        }
        return { kind: "failed", reason: "merge", message };
      }
      return askGitHubQueueRemoval(
        merge,
        `${removal.actor ? `@${removal.actor}` : "Someone"} removed ${pull.url ?? `pull request #${pull.number}`} from the ${name} GitHub merge queue${why}.`,
      );
    }
    case "closed":
      return askGitHubQueueRemoval(
        merge,
        `${pull.url ?? `Pull request #${pull.number}`} was closed on GitHub while it waited for the ${name} merge queue.`,
      );
    case "blocked":
    case "sha_moved":
      return { kind: "failed", reason: "merge", message: result.message };
  }
}

async function githubQueueCiFailed(
  merge: MergeContext,
  head: string,
  checks: readonly FailedCiCheck[],
  pullUrl: string | null,
  source: string,
): Promise<MergeStep> {
  const limit = merge.caps.ciFixAttempts(merge.item);
  const failed = checks.map((check) => ({
    name: check.name,
    state: "failed" as const,
    url: check.url,
    startedAt: null,
    completedAt: null,
    logTail: check.logTail ?? null,
    logSource: null,
  }));
  if (
    sendBack(merge, "ci-failed", (fixes) => fixes < limit, `${source}\n\n${ciFixHandoff(checks)}`, {
      thought: (attempt) => ciFixRoundLine(checks, attempt, limit),
      record: (_, attempt) => ciRound(merge, head, failed, "agent", limit, attempt),
    })
  )
    return { kind: "returned" };
  if (askHelp(merge, ciFixQuestion(checks, limit, pullUrl), "budget_spent")) {
    await merge.caps.voice.flush();
    return { kind: "asked" };
  }
  return {
    kind: "failed",
    reason: "merge",
    message: `CI failed: ${checks.map((check) => check.name).join(", ")}`,
  };
}

async function askGitHubQueueRemoval(merge: MergeContext, what: string): Promise<MergeStep> {
  const body = [
    what,
    "",
    "What should Paws do? Reply with what to change, and the agent works on it. Paws adds the pull request to the merge queue again after Closeout accepts the change. To leave it as it is, stop the task.",
  ].join("\n");
  if (askHelp(merge, body)) {
    await merge.caps.voice.flush();
    return { kind: "asked" };
  }
  return { kind: "failed", reason: "merge", message: what };
}

function credentials(
  github: GitHubBinding,
):
  | { tokenProvider: NonNullable<GitHubBinding["tokenProvider"]> }
  | { appId: string; installationId: string; privateKeyPem: string } {
  if (github.tokenProvider) return { tokenProvider: github.tokenProvider };
  return {
    appId: github.appId,
    installationId: github.installationId,
    privateKeyPem: github.privateKeyPem,
  };
}
