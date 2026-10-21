import { git } from "./run/exec";
import type { PublishedEvidence } from "./types";

/**
 * Keep the files published at `head` or at an earlier commit it contains.
 * Screenshots are usually taken before the last commit of a task.
 */
export async function publishedAtHead(
  repo: string,
  head: string,
  published: readonly PublishedEvidence[],
  env: Record<string, string>,
): Promise<PublishedEvidence[]> {
  const reachable = new Set<string>();
  for (const commit of new Set(published.map((entry) => entry.commit))) {
    if (commit === head) reachable.add(commit);
    else if (
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit) &&
      (await git(repo, ["merge-base", "--is-ancestor", commit, head], env)).ok
    )
      reachable.add(commit);
  }
  return published.filter((entry) => reachable.has(entry.commit));
}
