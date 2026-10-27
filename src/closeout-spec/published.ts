import { anyPathMatches, pathMatches } from "./evaluate/paths";
import { scrubCommandEnv } from "./run/env";
import { git } from "./run/exec";
import type { EvidenceApproval, PublishedEvidence } from "./types";

/**
 * Keep the files published at `head` or at an earlier commit it contains.
 * Screenshots are usually taken before the last commit of a task. Given
 * main's `base`, files published before a rebase that left the task's own
 * changes under the check's paths alone are kept too.
 */
export async function publishedAtHead(
  repo: string,
  head: string,
  published: readonly PublishedEvidence[],
  items: readonly { id: string; paths?: readonly string[] }[],
  env: Record<string, string>,
  base?: string,
): Promise<PublishedEvidence[]> {
  const kept: PublishedEvidence[] = [];
  for (const entry of published) {
    const paths = pathsOf(items, entry.checkId);
    if (entry.commit === head) kept.push(entry);
    else if (!COMMIT.test(entry.commit)) continue;
    else if ((await git(repo, ["merge-base", "--is-ancestor", entry.commit, head], env)).ok)
      kept.push(entry);
    else if (await unchangedSince(repo, entry.commit, head, paths, env)) kept.push(entry);
    else if (
      base !== undefined &&
      (await sameOwnChanges(repo, entry.commit, head, base, paths, env))
    )
      kept.push(entry);
  }
  return kept;
}

/**
 * Keep the approvals that still hold at `head`: nothing under the check's
 * paths changed since the approved commit, or, given main's `base`, the
 * task's own changes under those paths are the same as when they were
 * approved. A rebase that only brings in main's changes keeps the approval.
 */
export async function approvalsAtHead(
  repo: string,
  head: string,
  approvals: readonly EvidenceApproval[],
  items: readonly { id: string; paths?: readonly string[] }[],
  env: Record<string, string> = scrubCommandEnv(),
  base?: string,
): Promise<EvidenceApproval[]> {
  const kept: EvidenceApproval[] = [];
  for (const approval of approvals) {
    if (approval.commit === undefined || approval.commit === head) kept.push(approval);
    else if (!COMMIT.test(approval.commit)) continue;
    else if (
      await untouchedSince(repo, approval.commit, head, pathsOf(items, approval.checkId), env)
    )
      kept.push(approval);
    else if (
      base !== undefined &&
      (await sameOwnChanges(
        repo,
        approval.commit,
        head,
        base,
        pathsOf(items, approval.checkId),
        env,
      ))
    )
      kept.push(approval);
  }
  return kept;
}

/**
 * `before` and `after` carry the same patch against main's `base`: a rebase
 * that brought in only main's changes. Compares the whole diff, without
 * context lines, blob ids or hunk headers.
 */
export async function samePatch(
  repo: string,
  before: string,
  after: string,
  base: string,
  env: Record<string, string> = scrubCommandEnv(),
): Promise<boolean> {
  if (before === after) return true;
  if (!COMMIT.test(before) || !COMMIT.test(after)) return false;
  return sameOwnChanges(repo, before, after, base, undefined, env);
}

/** How far back `fixChangedPaths` looks for the commit a fix was made on. */
const FIX_COMMITS_MAX = 50;

/**
 * The files a fix changed on top of the approved patch, given main's `base`. A fix is commits
 * made on a commit that carries the approved patch: `approved` itself, or a rebase of it that
 * `samePatch` holds for. The nearest such commit on `head`'s first-parent line, down to where
 * `head` forked from main, is the fix's start, and the result is the diff from there to `head`.
 *
 * Null when `head` has no such commit, as after a rebase that changed the patch: a rebase keeps
 * the approval only under `samePatch`, never as a fix. Null too when git cannot read the commits.
 */
export async function fixChangedPaths(
  repo: string,
  approved: string,
  head: string,
  base: string,
  env: Record<string, string> = scrubCommandEnv(),
): Promise<string[] | null> {
  if (approved === head) return [];
  if (!COMMIT.test(approved) || !COMMIT.test(head)) return null;
  const fork = await forkPoint(repo, head, base, env);
  if (fork === null) return null;
  const listed = await git(
    repo,
    ["rev-list", "--first-parent", `--max-count=${FIX_COMMITS_MAX}`, `${fork}..${head}`],
    env,
  );
  if (!listed.ok) return null;
  // Newest first, skipping `head`: the closest commit with the approved patch.
  const commits = listed.stdout.toString("utf8").split("\n").filter(Boolean).slice(1);
  for (const commit of commits)
    if (await samePatch(repo, approved, commit, base, env))
      return changedPaths(repo, commit, head, env);
  return null;
}

async function forkPoint(
  repo: string,
  tip: string,
  base: string,
  env: Record<string, string>,
): Promise<string | null> {
  const fork = await git(repo, ["merge-base", tip, base], env);
  return fork.ok ? fork.stdout.toString("utf8").trim() : null;
}

function normalizedDiff(diff: string): string {
  return diff
    .split("\n")
    .filter((line) => !line.startsWith("index "))
    .map((line) => (line.startsWith("@@") ? "@@" : line))
    .join("\n");
}

async function sameOwnChanges(
  repo: string,
  approved: string,
  head: string,
  base: string,
  patterns: readonly string[] | undefined,
  env: Record<string, string>,
): Promise<boolean> {
  const before = await ownChanges(repo, approved, base, patterns, env);
  if (before === null) return false;
  const after = await ownChanges(repo, head, base, patterns, env);
  return after !== null && before === after;
}

/**
 * The task's diff from where `tip` forked from `base`, under the patterns,
 * with no context lines, blob ids or hunk headers, which move when main
 * changes nearby in the same file. Binary files carry their content.
 */
async function ownChanges(
  repo: string,
  tip: string,
  base: string,
  patterns: readonly string[] | undefined,
  env: Record<string, string>,
): Promise<string | null> {
  const fork = await git(repo, ["merge-base", tip, base], env);
  if (!fork.ok) return null;
  const from = fork.stdout.toString("utf8").trim();
  const changed = await changedPaths(repo, from, tip, env);
  if (changed === null) return null;
  const paths = patterns?.length
    ? changed.filter((path) => patterns.some((pattern) => pathMatches(pattern, path)))
    : changed;
  if (paths.length === 0) return "";
  const diff = await git(
    repo,
    [
      "diff",
      "--no-renames",
      "--no-color",
      "--no-ext-diff",
      // Only the task's own lines: context moves when main edits nearby.
      "--unified=0",
      // Binary content, so two different images never compare equal by name alone.
      "--binary",
      from,
      tip,
      "--",
      ...paths.map((path) => `:(literal)${path}`),
    ],
    env,
  );
  if (!diff.ok) return null;
  return normalizedDiff(diff.stdout.toString("utf8"));
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
