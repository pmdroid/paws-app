import { journalCaught } from "../journal";
import { z } from "zod";
import { acquireOperationToken } from "./auth/provider";
import type { GitHubCredentialInput } from "./auth/types";
import { repoApiPath } from "./client";
import type { GitHubClient } from "./types";

/** Reads of a pull request while GitHub still computes `mergeable`. */
export const PULL_MERGEABLE_READS = 4;
export const PULL_MERGEABLE_RETRY_MS = 2_000;

/**
 * Whether an open pull request's head merges into its base, as GitHub computed it. `conflict` is
 * `mergeable: false` or `mergeable_state: dirty`; `unknown` is GitHub not having computed it yet.
 */
export type PullMergeable = {
  head: string;
  open: boolean;
  merges: "clean" | "conflict" | "unknown";
};

const pullSchema = z.object({
  state: z.string(),
  mergeable: z.boolean().nullish(),
  mergeable_state: z.string().nullish(),
  head: z.object({ sha: z.string() }),
});

/**
 * Read the pull request's `mergeable`. GitHub computes it lazily after main moves, so a null is
 * read again a few times. Null when the pull request cannot be read.
 */
export async function readPullMergeable(
  input: {
    client: GitHubClient;
    owner: string;
    repo: string;
    prNumber: number;
    reads?: number;
    retryMs?: number;
    sleep?: (ms: number) => Promise<void>;
    signal?: AbortSignal;
  } & GitHubCredentialInput,
): Promise<PullMergeable | null> {
  const reads = input.reads ?? PULL_MERGEABLE_READS;
  const sleep = input.sleep ?? ((ms: number) => Bun.sleep(ms));
  let last: PullMergeable | null = null;
  for (let read = 1; read <= reads; read++) {
    if (read > 1) await sleep(input.retryMs ?? PULL_MERGEABLE_RETRY_MS);
    input.signal?.throwIfAborted();
    last = await readOnce(input);
    if (last === null || !last.open || last.merges !== "unknown") return last;
  }
  return last;
}

async function readOnce(
  input: Parameters<typeof readPullMergeable>[0],
): Promise<PullMergeable | null> {
  try {
    const token = await acquireOperationToken(input, "pr");
    const response = await input.client.request({
      method: "GET",
      path: repoApiPath(input.owner, input.repo, `/pulls/${input.prNumber}`),
      token,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const parsed = pullSchema.safeParse(response.body);
    if (response.status !== 200 || !parsed.success) return null;
    const pull = parsed.data;
    return {
      head: pull.head.sha,
      open: pull.state === "open",
      merges:
        pull.mergeable === false || pull.mergeable_state === "dirty"
          ? "conflict"
          : pull.mergeable === true
            ? "clean"
            : "unknown",
    };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    journalCaught(error, "pull-mergeable.readOnce", null);
    return null;
  }
}
