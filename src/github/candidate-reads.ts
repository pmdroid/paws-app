import {
  commitCoauthorTrailers,
  policyCoauthors,
  validateCommitAttribution,
  type GitCommitPolicy,
} from "../core";
import { acquireOperationToken } from "./auth/provider";
import { readTree, repositoryGet } from "./compare";
import type { GitHubGitRepository } from "./git-reader";

export async function validateGitHubCandidateAttribution(
  repository: GitHubGitRepository,
  base: string,
  head: string,
  policy: GitCommitPolicy,
  signal?: AbortSignal,
): Promise<void> {
  policyCoauthors(policy);
  if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha)))
    throw new Error("Invalid attribution candidate range");
  const get = repositoryGet({
    ...repository,
    token: await acquireOperationToken(repository, "pr"),
    signal,
  });
  const comparison = await get(`/compare/${base}...${head}?per_page=100&page=1`);
  if (comparison.status !== "ahead" && comparison.status !== "identical")
    throw new Error("Candidate does not descend from its base");
  const total = comparison.total_commits;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0)
    throw new Error("GitHub returned no candidate commit count");
  let validated = 0;
  let page = comparison;
  for (let number = 1; validated < total; number++) {
    if (number > 1) page = await get(`/compare/${base}...${head}?per_page=100&page=${number}`);
    if (!Array.isArray(page.commits) || page.commits.length === 0)
      throw new Error("GitHub returned an incomplete candidate range");
    for (const entry of page.commits) {
      const commit = entry.commit;
      if (!commit || typeof commit.message !== "string")
        throw new Error("GitHub returned incomplete commit attribution");
      validateCommitAttribution(
        policy,
        [
          commit.author?.name,
          commit.author?.email,
          commit.committer?.name,
          commit.committer?.email,
        ],
        commitCoauthorTrailers(commit.message),
      );
      validated++;
    }
  }
  if (validated !== total) throw new Error("GitHub returned an inconsistent candidate range");
}

export async function sameGitHubCandidatePatch(
  repository: GitHubGitRepository,
  before: string,
  after: string,
  base: string,
): Promise<boolean> {
  if (before === after) return true;
  if (![before, after, base].every((sha) => /^[a-f0-9]{40}$/.test(sha))) return false;
  const get = repositoryGet({
    ...repository,
    token: await acquireOperationToken(repository, "pr"),
    signal: AbortSignal.timeout(60_000),
  });
  const read = async (head: string) => {
    const comparison = await get(`/compare/${base}...${head}?per_page=1`);
    if (!Array.isArray(comparison.files) || comparison.files.length >= 300) return null;
    const files: string[] = [];
    for (const file of comparison.files) {
      if (typeof file.filename !== "string" || typeof file.patch !== "string") return null;
      const changes = file.patch
        .split("\n")
        .map((line: string) => line.replace(/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/, "@@ -$1 +$2 @@"));
      files.push(JSON.stringify([file.filename, file.previous_filename, file.status, changes]));
    }
    return files.sort().join("\n");
  };
  const [left, right] = await Promise.all([read(before), read(after)]);
  if (left === null || left !== right) return false;
  const [beforeTree, afterTree] = await Promise.all([readTree(get, before), readTree(get, after)]);
  const modes = (tree: typeof beforeTree) => new Map(tree.map((entry) => [entry.path, entry.mode]));
  const oldModes = modes(beforeTree);
  const newModes = modes(afterTree);
  for (const file of left.split("\n").filter(Boolean)) {
    const [path] = JSON.parse(file) as [string];
    if (oldModes.get(path) !== newModes.get(path)) return false;
  }
  return true;
}

export async function readGitHubCandidateRange(
  repository: GitHubGitRepository,
  head: string,
): Promise<{ head: string; base: string; commits: number }> {
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("Invalid candidate head");
  const get = repositoryGet({
    ...repository,
    token: await acquireOperationToken(repository, "pr"),
    signal: AbortSignal.timeout(60_000),
  });
  const comparison = await get(`/compare/main...${head}?per_page=1`);
  const base = (comparison.merge_base_commit as { sha?: unknown } | undefined)?.sha;
  const commits = comparison.ahead_by;
  if (
    typeof base !== "string" ||
    !/^[a-f0-9]{40}$/.test(base) ||
    typeof commits !== "number" ||
    !Number.isSafeInteger(commits) ||
    commits < 0
  )
    throw new Error("GitHub returned an incomplete candidate range");
  return { head, base, commits };
}
