import type { Database } from "bun:sqlite";
import { retryBackoffMs } from "../core";
import { GitHubRateLimitError, rateHoldMs, type GitHubIssuesClient } from "./client";
import {
  hasSeen,
  markSeen,
  readLabeled,
  readPollState,
  writeLabeled,
  writePollState,
} from "./store";
import {
  githubIdentifier,
  githubIssueKey,
  hasTriggerLabel,
  isPawsStop,
  mentionsPaws,
  repoSlug,
} from "./text";
import type { GitHubComment, GitHubIssue, GitHubRepoRef } from "./types";

/** Poll while a work item is open or a question is unanswered. */
export const GITHUB_POLL_ACTIVE_MS = 5_000;

/** Poll while nothing is in flight and no question is open. */
export const GITHUB_POLL_IDLE_MS = 15_000;

const OVERLAP_MS = 5_000;
const INITIAL_LOOKBACK_MS = 60 * 60 * 1000;

export function pollIntervalMs(workActive: boolean): number {
  return workActive ? GITHUB_POLL_ACTIVE_MS : GITHUB_POLL_IDLE_MS;
}

/** True when a non-terminal work item exists or a question is still open. */
export function githubWorkIsHot(db: Database): boolean {
  if (
    count(
      db,
      "SELECT COUNT(*) AS n FROM work_item WHERE state NOT IN ('completed', 'merged', 'cancelled')",
    ) > 0
  ) {
    return true;
  }
  return (
    count(db, "SELECT COUNT(*) AS n FROM question WHERE status = 'open' AND cancelled_at IS NULL") >
    0
  );
}

export type Sleeper = {
  wait(ms: number): Promise<void>;
  wake(): void;
};

export type GitHubTrigger = {
  kind: "label" | "mention";
  issueId: string;
  identifier: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string | null;
  commentId: number | null;
  authorLogin: string;
  updatedAtMs: number;
};

export type GitHubCommentEvent = {
  kind: "answer" | "stop";
  issueId: string;
  identifier: string;
  owner: string;
  repo: string;
  number: number;
  commentId: number;
  body: string;
  authorLogin: string;
  updatedAtMs: number;
};

export type GitHubIssuePoller = {
  stop(): Promise<void>;
  pollNow(): Promise<void>;
  settled: Promise<void>;
};

/**
 * Poll each configured repo's open issues and issue comments.
 * Active work or an open question waits 5s; idle waits 15s.
 * ETag and cursor live in SQLite. 304 does no work. 403/429 backs off, then resumes.
 */
export function startGitHubIssuePoller(options: {
  db: Database;
  client: GitHubIssuesClient;
  onTrigger: (event: GitHubTrigger) => Promise<void> | void;
  onComment: (event: GitHubCommentEvent) => Promise<void> | void;
  hot?: () => boolean;
  sleeper?: Sleeper;
  now?: () => number;
}): GitHubIssuePoller {
  const sleeper = options.sleeper ?? createTimerSleeper();
  const now = options.now ?? Date.now;
  const hot = options.hot ?? (() => githubWorkIsHot(options.db));
  const control = { stopped: false };
  let active: Promise<number> | null = null;
  let pending = false;
  let rateAttempts = 0;

  function pollOnce(): Promise<number> {
    if (control.stopped) return Promise.resolve(0);
    if (active) {
      pending = true;
      return active;
    }
    active = Promise.resolve()
      .then(async () => {
        let hold = 0;
        do {
          pending = false;
          hold = Math.max(hold, await pollBody());
        } while (pending && !control.stopped);
        return hold;
      })
      .finally(() => {
        active = null;
      });
    return active;
  }

  async function pollBody(): Promise<number> {
    const repos = [...options.client.config.repos];
    if (repos.length === 0) return 0;
    const actor = await options.client.user();
    let hold = 0;
    for (const repo of repos) {
      const pullNumbers = new Set<number>();
      hold = Math.max(hold, await pollIssues(repo, actor.login, pullNumbers));
      hold = Math.max(hold, await pollComments(repo, actor.login, pullNumbers));
    }
    return hold;
  }

  async function pollIssues(
    repo: GitHubRepoRef,
    actorLogin: string,
    pullNumbers: Set<number>,
  ): Promise<number> {
    const slug = repoSlug(repo);
    const saved = readPollState(options.db, slug, "issues");
    const sinceMs =
      saved === null ? now() - INITIAL_LOOKBACK_MS : Math.max(0, saved.cursorMs - OVERLAP_MS);
    const page = await options.client.listOpenIssues(
      repo,
      new Date(sinceMs).toISOString(),
      saved?.etag ?? null,
    );
    if (!page.notModified) {
      for (const issue of page.items) {
        if (issue.pullRequest) {
          pullNumbers.add(issue.number);
          continue;
        }
        await handleIssue(issue, actorLogin);
      }
    }
    writePollState(
      options.db,
      slug,
      "issues",
      { cursorMs: now(), etag: page.etag, url: page.url },
      now(),
    );
    return rateHoldMs(page.rate, now());
  }

  async function pollComments(
    repo: GitHubRepoRef,
    actorLogin: string,
    pullNumbers: ReadonlySet<number>,
  ): Promise<number> {
    const slug = repoSlug(repo);
    const saved = readPollState(options.db, slug, "comments");
    const sinceMs =
      saved === null ? now() - INITIAL_LOOKBACK_MS : Math.max(0, saved.cursorMs - OVERLAP_MS);
    const page = await options.client.listIssueComments(
      repo,
      new Date(sinceMs).toISOString(),
      saved?.etag ?? null,
    );
    if (!page.notModified) {
      for (const comment of page.items) {
        if (comment.pullRequest || pullNumbers.has(comment.number)) continue;
        await handleComment(comment, actorLogin);
      }
    }
    writePollState(
      options.db,
      slug,
      "comments",
      { cursorMs: now(), etag: page.etag, url: page.url },
      now(),
    );
    return rateHoldMs(page.rate, now());
  }

  async function handleIssue(issue: GitHubIssue, actorLogin: string): Promise<void> {
    const key = githubIssueKey(issue.owner, issue.repo, issue.number);
    const trusted = isTrusted(issue.authorLogin, issue.authorAssociation, actorLogin);
    const labeled = hasTriggerLabel(issue.labels, options.client.config.triggerLabel);
    const prior = readLabeled(options.db, key);
    if (labeled && prior !== 1) {
      if (!trusted) logIgnored("label", issue.authorAssociation, issue.authorLogin, key);
      else await options.onTrigger(triggerFrom(issue, "label", null, issue.body));
      writeLabeled(options.db, key, 1, now());
    } else if (!labeled && prior !== 0) {
      writeLabeled(options.db, key, 0, now());
    }
    if (issue.body !== null && mentionsPaws(issue.body, options.client.config.mention)) {
      const dedupe = `mention:${key}:${issue.updatedAtMs}`;
      if (hasSeen(options.db, dedupe)) return;
      if (!trusted) logIgnored("mention", issue.authorAssociation, issue.authorLogin, key);
      else if (!(labeled && prior !== 1)) {
        await options.onTrigger(triggerFrom(issue, "mention", null, issue.body));
      }
      markSeen(options.db, dedupe, now());
    }
  }

  async function handleComment(comment: GitHubComment, actorLogin: string): Promise<void> {
    const dedupe = `comment:${comment.id}`;
    if (hasSeen(options.db, dedupe)) return;
    const trusted = isTrusted(comment.authorLogin, comment.authorAssociation, actorLogin);
    const key = githubIssueKey(comment.owner, comment.repo, comment.number);
    if (!trusted) {
      logIgnored("comment", comment.authorAssociation, comment.authorLogin, key);
      markSeen(options.db, dedupe, now());
      return;
    }
    if (mentionsPaws(comment.body, options.client.config.mention)) {
      await options.onTrigger({
        kind: "mention",
        issueId: key,
        identifier: githubIdentifier(comment.repo, comment.number),
        owner: comment.owner,
        repo: comment.repo,
        number: comment.number,
        title: "",
        body: comment.body,
        commentId: comment.id,
        authorLogin: comment.authorLogin ?? "",
        updatedAtMs: comment.updatedAtMs,
      });
    }
    if (isPawsStop(comment.body)) {
      await options.onComment(commentEvent(comment, "stop"));
    } else if (!mentionsPaws(comment.body, options.client.config.mention)) {
      await options.onComment(commentEvent(comment, "answer"));
    }
    markSeen(options.db, dedupe, now());
  }

  function isTrusted(login: string | null, association: string, actorLogin: string): boolean {
    if (login !== null && login.toLowerCase() === actorLogin.toLowerCase()) return true;
    const have = association.toLowerCase();
    return options.client.config.trusted.some((role) => role.toLowerCase() === have);
  }

  const settled = (async () => {
    while (!control.stopped) {
      let delay = pollIntervalMs(hot());
      try {
        const hold = await pollOnce();
        delay = Math.max(delay, hold);
        rateAttempts = 0;
      } catch (error) {
        if (control.stopped) return;
        if (error instanceof GitHubRateLimitError) {
          rateAttempts += 1;
          const backoff = retryBackoffMs(rateAttempts, GITHUB_POLL_ACTIVE_MS, 60_000);
          delay = Math.max(backoff, error.retryAfterMs);
        } else {
          const message = error instanceof Error ? error.message : "github issue poll failed";
          console.error(`github issue poll failed: ${message}`);
        }
      }
      if (control.stopped) return;
      await sleeper.wait(delay);
      if (control.stopped) return;
    }
  })();

  return {
    async stop() {
      control.stopped = true;
      sleeper.wake();
      await Promise.allSettled([settled, active]);
    },
    async pollNow() {
      await pollOnce();
    },
    settled,
  };
}

function triggerFrom(
  issue: GitHubIssue,
  kind: GitHubTrigger["kind"],
  commentId: number | null,
  body: string | null,
): GitHubTrigger {
  return {
    kind,
    issueId: githubIssueKey(issue.owner, issue.repo, issue.number),
    identifier: githubIdentifier(issue.repo, issue.number),
    owner: issue.owner,
    repo: issue.repo,
    number: issue.number,
    title: issue.title,
    body,
    commentId,
    authorLogin: issue.authorLogin ?? "",
    updatedAtMs: issue.updatedAtMs,
  };
}

function commentEvent(
  comment: GitHubComment,
  kind: GitHubCommentEvent["kind"],
): GitHubCommentEvent {
  return {
    kind,
    issueId: githubIssueKey(comment.owner, comment.repo, comment.number),
    identifier: githubIdentifier(comment.repo, comment.number),
    owner: comment.owner,
    repo: comment.repo,
    number: comment.number,
    commentId: comment.id,
    body: comment.body,
    authorLogin: comment.authorLogin ?? "",
    updatedAtMs: comment.updatedAtMs,
  };
}

function logIgnored(
  kind: string,
  association: string,
  login: string | null,
  issueKey: string,
): void {
  console.warn(
    `github issues: ignored ${kind} from ${association} ${login ?? "unknown"} on ${issueKey}`,
  );
}

function count(db: Database, sql: string): number {
  try {
    const row = db.query<{ n: number }, []>(sql).get();
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

function createTimerSleeper(): Sleeper {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveWait: (() => void) | null = null;
  return {
    wait(ms) {
      return new Promise((resolve) => {
        resolveWait = resolve;
        timer = setTimeout(() => {
          timer = null;
          resolveWait = null;
          resolve();
        }, ms);
        unref(timer);
      });
    },
    wake() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const resolve = resolveWait;
      resolveWait = null;
      resolve?.();
    },
  };
}

function unref(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    const unrefTimer = timer.unref;
    if (typeof unrefTimer === "function") unrefTimer.call(timer);
  }
}
