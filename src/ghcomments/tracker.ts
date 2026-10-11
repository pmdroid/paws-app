import type {
  CommentBoard,
  CommentMode,
  CommentModeOptions,
  CommentRunPhase,
  IssueComment,
} from "../comments";
import { createCommentMode } from "../comments";
import { NotImplementedError, systemClock, type Clock, type CommandBus } from "../core";
import type { Elicitation, ProgressUpdate, StatusUpdate, TrackerAdapter } from "../linear";
import type { GitHubCommentRequest, GitHubIssueComment } from "./board";
import { createGitHubCommentBoard } from "./board";
import { canonicalIssueId, repoPath, resolveGitHubIssue, type GitHubIssueRef } from "./issue";

/** Authors who may answer or `/paws stop`, besides the authenticated user. */
export const DEFAULT_TRUSTED_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"] as const;

export const PAWS_LABEL_RUNNING = "paws:running";
export const PAWS_LABEL_AWAITING = "paws:awaiting-input";
export const PAWS_LABEL_DONE = "paws:done";

const STATUS_LABELS = [PAWS_LABEL_RUNNING, PAWS_LABEL_AWAITING, PAWS_LABEL_DONE] as const;

const LABEL_COLORS: Record<(typeof STATUS_LABELS)[number], string> = {
  [PAWS_LABEL_RUNNING]: "1D76DB",
  [PAWS_LABEL_AWAITING]: "FBCA04",
  [PAWS_LABEL_DONE]: "0E8A16",
};

const STATUS_TEXT: Record<StatusUpdate["stateType"], string> = {
  started: "Started.",
  completed: "Done.",
  canceled: "Canceled.",
};

export type GitHubCommentTrackerOptions = {
  request: GitHubCommentRequest;
  owner: string;
  repo: string;
  clock?: Clock;
  /** Login of the token user. Always trusted, even when `author_association` is not. */
  selfLogin?: string;
  /** Defaults to OWNER, MEMBER, and COLLABORATOR. */
  trustedAssociations?: readonly string[];
  /** When false, status changes stay on the comment and no labels are written. Defaults to true. */
  labels?: boolean;
  commands?: CommandBus;
  onResume?: CommentModeOptions["onResume"];
  onStop?: CommentModeOptions["onStop"];
};

export type GitHubCommentTracker = TrackerAdapter & {
  bind(binding: { itemId: string; issueId: string; sessionId?: string }): void;
  sync: CommentMode["sync"];
  phase(itemId: string): CommentRunPhase;
};

/**
 * Comment-mode tracker for a GitHub issue.
 * Progress, questions, and status are issue comments. The matching label is
 * `paws:running`, `paws:awaiting-input`, or `paws:done`.
 * Epic reads belong to the GitHub issue adapter.
 */
export function createGitHubCommentTracker(
  options: GitHubCommentTrackerOptions,
): GitHubCommentTracker {
  const fallback = { owner: options.owner, repo: options.repo };
  const clock = options.clock ?? systemClock;
  const allowed = new Set(
    (options.trustedAssociations ?? DEFAULT_TRUSTED_ASSOCIATIONS).map((name) => name.toUpperCase()),
  );
  let selfLogin = options.selfLogin ?? null;
  const sessionIssue = new Map<string, string>();
  const sessionItem = new Map<string, string>();
  const ensuredLabels = new Set<string>();
  const inner = createGitHubCommentBoard({
    request: options.request,
    owner: options.owner,
    repo: options.repo,
  });
  const board: CommentBoard = {
    async create(input) {
      const created = await inner.create(input);
      rememberLogin(created);
      return created;
    },
    update: (input) => inner.update(input),
    async list(issueId) {
      const comments = await inner.list(issueId);
      return comments.filter((comment) => isTrusted(comment));
    },
  };
  const mode = createCommentMode({
    board,
    clock,
    selfDetection: "marker",
    ...(options.commands === undefined ? {} : { commands: options.commands }),
    ...(options.onResume === undefined ? {} : { onResume: options.onResume }),
    ...(options.onStop === undefined ? {} : { onStop: options.onStop }),
  });

  function issueIdFor(issueId: string): string {
    return canonicalIssueId(issueId, fallback);
  }

  function rememberLogin(comment: IssueComment): void {
    if (selfLogin !== null) return;
    const login = authorOf(comment).authorLogin;
    if (login !== null) selfLogin = login;
  }

  function isTrusted(comment: IssueComment): boolean {
    const author = authorOf(comment);
    if (selfLogin !== null && author.authorLogin === selfLogin) return true;
    return author.authorAssociation !== null && allowed.has(author.authorAssociation.toUpperCase());
  }

  function remember(itemId: string, issueId: string, sessionId: string): void {
    sessionIssue.set(itemId, issueId);
    sessionIssue.set(sessionId, issueId);
    sessionIssue.set(issueId, issueId);
    sessionItem.set(itemId, itemId);
    sessionItem.set(sessionId, itemId);
    sessionItem.set(issueId, itemId);
  }

  function bind(binding: { itemId: string; issueId: string; sessionId?: string }): void {
    const issueId = issueIdFor(binding.issueId);
    const sessionId = binding.sessionId ?? binding.itemId;
    mode.bind({ itemId: binding.itemId, linearIssueId: issueId, sessionId });
    remember(binding.itemId, issueId, sessionId);
  }

  function ensure(sessionId: string): string {
    const known = sessionIssue.get(sessionId);
    if (known !== undefined) return known;
    const issueId = issueIdFor(sessionId);
    mode.bind({ itemId: sessionId, linearIssueId: issueId, sessionId });
    remember(sessionId, issueId, sessionId);
    return issueId;
  }

  function stopped(sessionId: string): boolean {
    return mode.phase(sessionItem.get(sessionId) ?? sessionId) === "stopped";
  }

  async function postProgress(update: ProgressUpdate): Promise<void> {
    const issueId = ensure(update.sessionId);
    if (stopped(update.sessionId)) return;
    await mode.postProgress(update);
    if (update.kind !== "response") await applyLabel(issueId, labelForProgress(update.kind));
  }

  async function askQuestion(question: Elicitation): Promise<void> {
    const issueId = ensure(question.sessionId);
    if (stopped(question.sessionId)) return;
    await mode.askQuestion(question);
    await applyLabel(issueId, PAWS_LABEL_AWAITING);
  }

  async function setStatus(update: StatusUpdate): Promise<void> {
    const issueId = ensure(update.linearIssueId);
    if (stopped(update.linearIssueId)) return;
    await mode.postProgress({
      sessionId: update.linearIssueId,
      kind: "thought",
      body: STATUS_TEXT[update.stateType],
    });
    await applyLabel(issueId, labelForStatus(update.stateType));
  }

  async function applyLabel(issueId: string, label: string | null): Promise<void> {
    if (options.labels === false) return;
    const target = resolveGitHubIssue(issueId, fallback);
    if (label !== null) await ensureLabel(target, label);
    for (const name of STATUS_LABELS) {
      if (name === label) continue;
      await deleteLabel(target, name);
    }
    if (label === null) return;
    const added = await options.request({
      method: "POST",
      path: repoPath(target.owner, target.repo, `/issues/${target.number}/labels`),
      body: { labels: [label] },
    });
    if (added.status !== 200 && added.status !== 201) {
      throw new Error(`adding a GitHub label failed with status ${added.status}`);
    }
  }

  async function ensureLabel(target: GitHubIssueRef, label: string): Promise<void> {
    const key = `${target.owner}/${target.repo}/${label}`;
    if (ensuredLabels.has(key)) return;
    const color = LABEL_COLORS[label as (typeof STATUS_LABELS)[number]] ?? "1D76DB";
    const created = await options.request({
      method: "POST",
      path: repoPath(target.owner, target.repo, "/labels"),
      body: { name: label, color, description: "Paws status" },
    });
    if (created.status !== 200 && created.status !== 201 && created.status !== 422) {
      throw new Error(`creating a GitHub label failed with status ${created.status}`);
    }
    ensuredLabels.add(key);
  }

  async function deleteLabel(target: GitHubIssueRef, label: string): Promise<void> {
    const removed = await options.request({
      method: "DELETE",
      path: repoPath(
        target.owner,
        target.repo,
        `/issues/${target.number}/labels/${encodeURIComponent(label)}`,
      ),
    });
    if (removed.status !== 200 && removed.status !== 204 && removed.status !== 404) {
      throw new Error(`removing a GitHub label failed with status ${removed.status}`);
    }
  }

  return {
    bind,
    async loadEpic() {
      throw new NotImplementedError("GitHub epic snapshot");
    },
    async listDeps() {
      throw new NotImplementedError("GitHub dependency list");
    },
    postProgress,
    askQuestion,
    setStatus,
    sync: (issueId, pending) => mode.sync(issueIdFor(issueId), pending),
    phase: (itemId) => mode.phase(itemId),
  };
}

function labelForProgress(kind: ProgressUpdate["kind"]): string {
  if (kind === "elicitation") return PAWS_LABEL_AWAITING;
  return PAWS_LABEL_RUNNING;
}

function labelForStatus(state: StatusUpdate["stateType"]): string | null {
  if (state === "started") return PAWS_LABEL_RUNNING;
  if (state === "completed") return PAWS_LABEL_DONE;
  return null;
}

function authorOf(comment: IssueComment): {
  authorLogin: string | null;
  authorAssociation: string | null;
} {
  const extra = comment as GitHubIssueComment;
  return {
    authorLogin: extra.authorLogin ?? comment.userId,
    authorAssociation: extra.authorAssociation ?? null,
  };
}
