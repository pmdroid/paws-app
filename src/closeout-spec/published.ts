import { anyPathMatches } from "./evaluate/paths";
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
  items: readonly { id: string; paths?: readonly string[] }[],
  env: Record<string, string>,
): Promise<PublishedEvidence[]> {
  const kept: PublishedEvidence[] = [];
  for (const entry of published) {
    if (entry.commit === head) kept.push(entry);
    else if (!COMMIT.test(entry.commit)) continue;
    else if ((await git(repo, ["merge-base", "--is-ancestor", entry.commit, head], env)).ok)
      kept.push(entry);
    else if (await unchangedSince(repo, entry.commit, head, pathsOf(items, entry.checkId), env))
      kept.push(entry);
  }
  return kept;
}

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function pathsOf(items: readonly { id: string; paths?: readonly string[] }[], id: string) {
  return items.find((item) => item.id === id)?.paths;
}

async function unchangedSince(
  repo: string,
  commit: string,
  head: string,
  patterns: readonly string[] | undefined,
  env: Record<string, string>,
): Promise<boolean> {
  if (!patterns?.length) return false;
  const diff = await git(
    repo,
    ["diff", "--name-only", "--no-renames", "-z", commit, head, "--"],
    env,
  );
  if (!diff.ok) return false;
  const paths = diff.stdout
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0);
  return !anyPathMatches(patterns, paths);
}
