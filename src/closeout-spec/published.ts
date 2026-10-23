import { anyPathMatches } from "./evaluate/paths";
import { scrubCommandEnv } from "./run/env";
import { git } from "./run/exec";
import type { EvidenceApproval, PublishedEvidence } from "./types";

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

export async function approvalsAtHead(
  repo: string,
  head: string,
  approvals: readonly EvidenceApproval[],
  items: readonly { id: string; paths?: readonly string[] }[],
  env: Record<string, string> = scrubCommandEnv(),
): Promise<EvidenceApproval[]> {
  const kept: EvidenceApproval[] = [];
  for (const approval of approvals) {
    if (approval.commit === undefined || approval.commit === head) kept.push(approval);
    else if (!COMMIT.test(approval.commit)) continue;
    else if (
      await untouchedSince(repo, approval.commit, head, pathsOf(items, approval.checkId), env)
    )
      kept.push(approval);
  }
  return kept;
}

async function untouchedSince(
  repo: string,
  commit: string,
  head: string,
  patterns: readonly string[] | undefined,
  env: Record<string, string>,
): Promise<boolean> {
  const changed = await changedPaths(repo, commit, head, env);
  if (changed === null) return false;
  return patterns?.length ? !anyPathMatches(patterns, changed) : changed.length === 0;
}

async function changedPaths(
  repo: string,
  commit: string,
  head: string,
  env: Record<string, string>,
): Promise<string[] | null> {
  const diff = await git(
    repo,
    ["diff", "--name-only", "--no-renames", "-z", commit, head, "--"],
    env,
  );
  if (!diff.ok) return null;
  return diff.stdout
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0);
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
  const paths = await changedPaths(repo, commit, head, env);
  return paths !== null && !anyPathMatches(patterns, paths);
}
