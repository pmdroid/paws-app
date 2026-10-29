import {
  HIGH_RISK_PATHS_FILE,
  HIGH_RISK_PATHS_FILE_MAX_BYTES,
  classifyRiskByList,
  parseHighRiskPathsFile,
  type RiskClassification,
  type RiskMatch,
} from "../core";

/** Runs `git` with the arguments in the candidate's worktree and returns stdout. */
export type RiskGit = (args: string[]) => Promise<string>;

/**
 * The tier of the candidate at `head`: every path it changes since `base`, matched against the
 * repository's settings globs and the `.paws/high-risk-paths` file at `base`. Reading the file
 * from the base commit means a pull request cannot remove its own paths. A rename counts as
 * both paths, so moving a file out of a high-risk directory is still high. `matches` names the
 * list that matched each path.
 */
export async function classifyCandidateRisk(input: {
  git: RiskGit;
  base: string;
  head: string;
  settingsGlobs: readonly string[];
}): Promise<RiskClassification & { matches: RiskMatch[] }> {
  return classifyPathsRisk({
    ...input,
    changed: await changedPaths(input.git, input.base, input.head),
  });
}

/** Every path the candidate at `head` changes since `base`. A rename counts as both paths. */
export async function changedPaths(git: RiskGit, base: string, head: string): Promise<string[]> {
  return (await git(["diff", "--name-only", "--no-renames", "-z", base, head, "--"]))
    .split("\0")
    .filter((path) => path !== "");
}

/**
 * The tier of a list of changed paths, such as the files a fix changed since an approved head,
 * against the settings globs and the `.paws/high-risk-paths` file at `base`. `matches` names
 * the list that matched each path.
 */
export async function classifyPathsRisk(input: {
  git: RiskGit;
  base: string;
  changed: readonly string[];
  settingsGlobs: readonly string[];
}): Promise<RiskClassification & { matches: RiskMatch[] }> {
  const fileGlobs = (await highRiskPathsFileAt(input.git, input.base)) ?? [];
  return classifyRiskByList(input.changed, { settings: input.settingsGlobs, file: fileGlobs });
}

/** The globs in `.paws/high-risk-paths` at `commit`, or null when the commit has no such file. */
export async function highRiskPathsFileAt(git: RiskGit, commit: string): Promise<string[] | null> {
  const listed = await git(["ls-tree", "-z", commit, "--", HIGH_RISK_PATHS_FILE]);
  if (!listed.startsWith("100")) return null;
  const text = await git(["cat-file", "blob", `${commit}:${HIGH_RISK_PATHS_FILE}`]);
  return parseHighRiskPathsFile(text.slice(0, HIGH_RISK_PATHS_FILE_MAX_BYTES));
}
