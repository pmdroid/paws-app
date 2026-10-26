import { journalCaught } from "../journal";
import { z } from "zod";
import { acquireOperationToken } from "./auth/provider";
import type { GitHubTokenProvider } from "./auth/types";
import { readMergeReadiness, type FailedCheck } from "./readiness";
import type { GitHubClient } from "./types";

/** GitHub's `MergeQueueEntryState`. */
export type MergeQueueEntryState =
  | "QUEUED"
  | "AWAITING_CHECKS"
  | "MERGEABLE"
  | "UNMERGEABLE"
  | "LOCKED";

/** Why GitHub's merge queue let go of a pull request. */
export type MergeQueueRemovalCause = "failed" | "conflict" | "person";

export type MergeQueueRemoval = {
  cause: MergeQueueRemovalCause;
  /** GitHub's reason text, if any. */
  reason: string;
  /** The login that removed it. */
  actor: string | null;
};

export type MergeQueueEntryRead =
  | { kind: "merged"; sha: string | null }
  | { kind: "closed" }
  | {
      kind: "queued";
      pullRequestId: string;
      head: string;
      position: number | null;
      state: MergeQueueEntryState;
    }
  | {
      kind: "not_queued";
      pullRequestId: string;
      head: string;
      baseBranch: string;
      /** The last merge queue event is a removal. */
      lastRemoval: MergeQueueRemoval | null;
    };

type GraphQLInput = {
  client: GitHubClient;
  token: string;
  owner: string;
  repo: string;
  signal?: AbortSignal;
};

const existsQuery = `query MergeQueueExists($owner: String!, $repo: String!, $branch: String) {
  repository(owner: $owner, name: $repo) { mergeQueue(branch: $branch) { id } }
}`;

const entryQuery = `query MergeQueueEntry($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id
      state
      headRefOid
      baseRefName
      mergeCommit { oid }
      mergeQueueEntry { position state }
      timelineItems(last: 1, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT]) {
        nodes {
          kind: __typename
          ... on RemovedFromMergeQueueEvent { reason actor { login } }
        }
      }
    }
  }
}`;

const enqueueMutation = `mutation EnqueuePullRequest($id: ID!, $head: GitObjectID) {
  enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $head }) {
    mergeQueueEntry { position state }
  }
}`;

const dequeueMutation = `mutation DequeuePullRequest($id: ID!) {
  dequeuePullRequest(input: { id: $id }) { clientMutationId }
}`;

const entryStateSchema = z.enum([
  "QUEUED",
  "AWAITING_CHECKS",
  "MERGEABLE",
  "UNMERGEABLE",
  "LOCKED",
]);
const entrySchema = z
  .object({ position: z.number().int().nullable().optional(), state: entryStateSchema })
  .nullable()
  .optional();

const existsSchema = z.object({
  errors: z.array(z.unknown()).optional(),
  data: z.object({
    repository: z.object({ mergeQueue: z.object({ id: z.string() }).nullable() }).nullable(),
  }),
});

const entryResponseSchema = z.object({
  errors: z.array(z.unknown()).optional(),
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        id: z.string(),
        state: z.enum(["OPEN", "CLOSED", "MERGED"]),
        headRefOid: z.string(),
        baseRefName: z.string(),
        mergeCommit: z.object({ oid: z.string() }).nullable().optional(),
        mergeQueueEntry: entrySchema,
        timelineItems: z
          .object({
            nodes: z.array(
              z
                .object({
                  kind: z.string(),
                  reason: z.string().nullable().optional(),
                  actor: z.object({ login: z.string() }).nullable().optional(),
                })
                .nullable(),
            ),
          })
          .optional(),
      }),
    }),
  }),
});

const enqueueSchema = z.object({
  errors: z.array(z.object({ message: z.string().optional() }).passthrough()).optional(),
  data: z
    .object({
      enqueuePullRequest: z.object({ mergeQueueEntry: entrySchema }).nullable(),
    })
    .nullable()
    .optional(),
});

async function graphql(
  input: GraphQLInput,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  input.signal?.throwIfAborted();
  return input.client.request({
    method: "POST",
    path: "/graphql",
    token: input.token,
    body: { query, variables },
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

/**
 * Whether `branch` uses GitHub's merge queue (`repository.mergeQueue(branch:)`). Null when GitHub
 * could not be read.
 */
export async function hasMergeQueue(
  input: GraphQLInput & { branch: string },
): Promise<boolean | null> {
  try {
    const response = await graphql(input, existsQuery, {
      owner: input.owner,
      repo: input.repo,
      branch: input.branch,
    });
    const parsed = existsSchema.safeParse(response.body);
    if (response.status !== 200 || !parsed.success || parsed.data.errors?.length) return null;
    return parsed.data.data.repository?.mergeQueue != null;
  } catch (error) {
    journalCaught(error, "merge-queue.hasMergeQueue.graphql", null);
    input.signal?.throwIfAborted();

    return null;
  }
}

/** The pull request's merge queue entry, or how it left the queue. Null when unreadable. */
export async function readMergeQueueEntry(
  input: GraphQLInput & { prNumber: number },
): Promise<MergeQueueEntryRead | null> {
  try {
    const response = await graphql(input, entryQuery, {
      owner: input.owner,
      repo: input.repo,
      number: input.prNumber,
    });
    const parsed = entryResponseSchema.safeParse(response.body);
    if (response.status !== 200 || !parsed.success || parsed.data.errors?.length) {
      console.error(`GitHub merge queue entry read failed: status ${response.status}`);
      return null;
    }
    const pull = parsed.data.data.repository.pullRequest;
    if (pull.state === "MERGED") return { kind: "merged", sha: pull.mergeCommit?.oid ?? null };
    if (pull.state === "CLOSED") return { kind: "closed" };
    if (pull.mergeQueueEntry)
      return {
        kind: "queued",
        pullRequestId: pull.id,
        head: pull.headRefOid,
        position: pull.mergeQueueEntry.position ?? null,
        state: pull.mergeQueueEntry.state,
      };
    const last = pull.timelineItems?.nodes.at(-1) ?? null;
    return {
      kind: "not_queued",
      pullRequestId: pull.id,
      head: pull.headRefOid,
      baseBranch: pull.baseRefName,
      lastRemoval:
        last?.kind === "RemovedFromMergeQueueEvent"
          ? classifyRemoval(last.reason ?? "", last.actor ?? null)
          : null,
    };
  } catch (error) {
    journalCaught(error, "merge-queue.readMergeQueueEntry.graphql", null);
    input.signal?.throwIfAborted();

    return null;
  }
}

/**
 * GitHub's removal reason is free text. A conflict or a failing check goes back to the agent.
 * Anything else, such as a person dequeuing the pull request, asks the team.
 */
export function classifyRemoval(
  reason: string,
  actor: { login: string } | null,
): MergeQueueRemoval {
  const text = reason.toLowerCase().replaceAll("_", " ");
  const cause: MergeQueueRemovalCause = /conflict/.test(text)
    ? "conflict"
    : /(fail|check|status|\bci\b|timed? ?out|error)/.test(text)
      ? "failed"
      : "person";
  return { cause, reason: reason.trim(), actor: actor?.login ?? null };
}

export type EnqueueResult =
  | { ok: true; position: number | null; state: MergeQueueEntryState }
  | { ok: false; retry: boolean; message: string };

/** `enqueuePullRequest`, pinned to the head Paws verified. */
export async function enqueuePullRequest(
  input: GraphQLInput & { pullRequestId: string; head: string },
): Promise<EnqueueResult> {
  try {
    const response = await graphql(input, enqueueMutation, {
      id: input.pullRequestId,
      head: input.head,
    });
    const parsed = enqueueSchema.safeParse(response.body);
    if (response.status !== 200 || !parsed.success)
      return {
        ok: false,
        retry: true,
        message: `GitHub did not accept the merge queue request (status ${response.status}).`,
      };
    if (parsed.data.errors?.length) {
      const message = parsed.data.errors
        .map((error) => error.message)
        .filter(Boolean)
        .join("; ");
      return {
        ok: false,
        retry: false,
        message: `GitHub refused to add the pull request to the merge queue: ${message || "unknown error"}`,
      };
    }
    const entry = parsed.data.data?.enqueuePullRequest?.mergeQueueEntry;
    return { ok: true, position: entry?.position ?? null, state: entry?.state ?? "QUEUED" };
  } catch (error) {
    journalCaught(error, "merge-queue.enqueuePullRequest.graphql", null);
    input.signal?.throwIfAborted();
    return { ok: false, retry: true, message: `merge queue request failed: ${safeMessage(error)}` };
  }
}

/** Where the pull request stands after {@link leaveGitHubMergeQueue}. */
export type LeaveMergeQueueResult = "left" | "not_queued" | "merged" | "closed";

/**
 * Take the pull request out of GitHub's merge queue, so GitHub does not merge a head whose
 * review asked for changes. Throws when GitHub cannot be read or refuses, so the caller retries.
 */
export async function leaveGitHubMergeQueue(input: {
  client: GitHubClient;
  owner: string;
  repo: string;
  prNumber: number;
  tokenProvider?: GitHubTokenProvider;
  appId?: string;
  installationId?: string;
  privateKeyPem?: string;
  signal?: AbortSignal;
}): Promise<LeaveMergeQueueResult> {
  const token = await acquireOperationToken(input, "merge");
  const graph = { client: input.client, token, owner: input.owner, repo: input.repo };
  const entry = await readMergeQueueEntry({
    ...graph,
    prNumber: input.prNumber,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (entry === null) throw new Error("could not read the pull request's merge queue entry");
  if (entry.kind !== "queued") return entry.kind;
  const response = await graphql(
    { ...graph, ...(input.signal ? { signal: input.signal } : {}) },
    dequeueMutation,
    { id: entry.pullRequestId },
  );
  const parsed = z
    .object({
      errors: z.array(z.object({ message: z.string().optional() }).passthrough()).optional(),
    })
    .safeParse(response.body);
  if (response.status !== 200 || !parsed.success || parsed.data.errors?.length)
    throw new Error(
      `GitHub did not take the pull request out of the merge queue (status ${response.status})`,
    );
  return "left";
}

export type GitHubQueueMergeInput = {
  owner: string;
  repo: string;
  prNumber: number;
  /** The head Closeout accepted. GitHub refuses to queue another head. */
  head: string;
  client: GitHubClient;
  appId?: string;
  installationId?: string;
  privateKeyPem?: string;
  tokenProvider?: GitHubTokenProvider;
  /** This merge pass already saw the pull request in the queue, so a removal is news. */
  queued: boolean;
  isCancelled?: () => boolean;
  now?: () => Date;
  signal?: AbortSignal;
};

export type GitHubQueueMergeResult =
  | { outcome: "merged"; sha: string | null }
  | { outcome: "no_queue"; message: string }
  /** Waiting for the pull request's own checks before it joins the queue. */
  | { outcome: "checks_pending"; message: string }
  | { outcome: "queued"; position: number | null; state: MergeQueueEntryState }
  | { outcome: "ci_failed"; message: string; failedChecks: FailedCheck[] }
  | { outcome: "removed"; removal: MergeQueueRemoval }
  | { outcome: "closed"; message: string }
  | { outcome: "unreadable"; message: string }
  | { outcome: "blocked" | "sha_moved"; message: string };

/**
 * One pass for the "Add to the GitHub merge queue" order. Paws does not rebase or re-check: once
 * the pull request's own checks pass it calls `enqueuePullRequest`, then reads the entry on each
 * pass until GitHub merges or removes it.
 */
export async function githubQueueMerge(
  input: GitHubQueueMergeInput,
): Promise<GitHubQueueMergeResult> {
  if (input.isCancelled?.()) return { outcome: "blocked", message: "merge cancelled" };
  const token = await acquireOperationToken(
    {
      tokenProvider: input.tokenProvider,
      client: input.client,
      appId: input.appId,
      installationId: input.installationId,
      privateKeyPem: input.privateKeyPem,
      owner: input.owner,
      repo: input.repo,
      ...(input.now ? { now: input.now() } : {}),
    },
    "merge",
  );
  const base = {
    client: input.client,
    token,
    owner: input.owner,
    repo: input.repo,
    ...(input.signal ? { signal: input.signal } : {}),
  };
  const entry = await readMergeQueueEntry({ ...base, prNumber: input.prNumber });
  if (entry === null)
    return { outcome: "unreadable", message: "Could not read the GitHub merge queue." };
  if (entry.kind === "merged") return { outcome: "merged", sha: entry.sha };
  if (entry.kind === "closed")
    return { outcome: "closed", message: "The pull request was closed on GitHub." };
  if (entry.kind === "queued")
    return { outcome: "queued", position: entry.position, state: entry.state };
  if (input.queued && entry.lastRemoval) return { outcome: "removed", removal: entry.lastRemoval };
  if (entry.head !== input.head)
    return { outcome: "sha_moved", message: "pull request head changed before it was queued" };
  const exists = await hasMergeQueue({ ...base, branch: entry.baseBranch });
  if (exists === null)
    return { outcome: "unreadable", message: "Could not read the GitHub merge queue." };
  if (!exists)
    return {
      outcome: "no_queue",
      message: `${entry.baseBranch} in ${input.owner}/${input.repo} has no GitHub merge queue.`,
    };
  const readiness = await readMergeReadiness({
    client: input.client,
    token: async () => token,
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    head: input.head,
  });
  if (readiness.outcome === "pending")
    return { outcome: "checks_pending", message: readiness.message };
  if (readiness.outcome === "ci_failed")
    return {
      outcome: "ci_failed",
      message: readiness.message,
      failedChecks: readiness.failedChecks ?? [],
    };
  if (readiness.outcome !== "ready") {
    if (readiness.message.startsWith("could not read"))
      return { outcome: "unreadable", message: readiness.message };
    return { outcome: readiness.outcome, message: readiness.message };
  }
  if (input.isCancelled?.()) return { outcome: "blocked", message: "merge cancelled" };
  const queued = await enqueuePullRequest({
    ...base,
    pullRequestId: entry.pullRequestId,
    head: input.head,
  });
  if (!queued.ok)
    return queued.retry
      ? { outcome: "unreadable", message: queued.message }
      : { outcome: "blocked", message: queued.message };
  return { outcome: "queued", position: queued.position, state: queued.state };
}

const ORDINALS = [
  "First",
  "Second",
  "Third",
  "Fourth",
  "Fifth",
  "Sixth",
  "Seventh",
  "Eighth",
  "Ninth",
  "Tenth",
];
const STATE_TEXT: Record<MergeQueueEntryState, string> = {
  QUEUED: "queued",
  AWAITING_CHECKS: "waiting for checks",
  MERGEABLE: "ready to merge",
  UNMERGEABLE: "cannot merge",
  LOCKED: "merging",
};

/** For example "Second in the acme/platform GitHub merge queue, waiting for checks." */
export function githubQueueLine(
  repository: string,
  position: number | null,
  state: MergeQueueEntryState,
): string {
  const place =
    position === null || position < 1
      ? `In the ${repository} GitHub merge queue`
      : `${ORDINALS[position - 1] ?? `Number ${position}`} in the ${repository} GitHub merge queue`;
  return `${place}, ${STATE_TEXT[state]}.`;
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "[redacted]")
    .slice(0, 300);
}

/**
 * The repositories (`owner/repo`) whose `branch` has a GitHub merge queue. A repository Paws
 * cannot read is left out. Throws only when none of them could be read.
 */
export async function repositoriesWithMergeQueue<R extends { owner: string; repo: string }>(input: {
  repositories: readonly R[];
  token: (repository: R) => Promise<string | null>;
  client: GitHubClient;
  branch?: string;
  signal?: AbortSignal;
}): Promise<string[]> {
  const results = await Promise.all(
    input.repositories.map(async (repository) => {
      const token = await input.token(repository).catch((caughtError1) => {
        journalCaught(caughtError1, "merge-queue.repositoriesWithMergeQueue.token", null);
        return null;
      });
      if (token === null) return null;
      const found = await hasMergeQueue({
        client: input.client,
        token,
        owner: repository.owner,
        repo: repository.repo,
        branch: input.branch ?? "main",
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return found === null ? null : { name: `${repository.owner}/${repository.repo}`, found };
    }),
  );
  const read = results.filter((entry) => entry !== null);
  if (read.length === 0 && input.repositories.length > 0)
    throw new Error("No repository's merge queue could be read.");
  return read.filter((entry) => entry.found).map((entry) => entry.name);
}
