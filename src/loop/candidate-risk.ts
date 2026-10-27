import {
  HIGH_RISK_PATHS_FILE,
  HIGH_RISK_PATHS_FILE_MAX_BYTES,
  classifyRisk,
  parseHighRiskPathsFile,
  type RiskClassification,
} from "../core";

/** Runs `git` with the arguments in the candidate's worktree and returns stdout. */
export type RiskGit = (args: string[]) => Promise<string>;

/**
 * The tier of the candidate at `head`: every path it changes since `base`, matched against the
 * repository's settings globs and the `.paws/high-risk-paths` file at `base`. Reading the file
 * from the base commit means a pull request cannot remove its own paths. A rename counts as
 * both paths, so moving a file out of a high-risk directory is still high.
 */
export async function classifyCandidateRisk(input: {
  git: RiskGit;
  base: string;
  head: string;
  settingsGlobs: readonly string[];
}): Promise<RiskClassification> {
  const changed = (
    await input.git(["diff", "--name-only", "--no-renames", "-z", input.base, input.head, "--"])
  )
    .split("\0")
    .filter((path) => path !== "");
  return classifyPathsRisk({ ...input, changed });
}

/**
 * The tier of a list of changed paths, such as the files a fix changed since an approved head,
 * against the settings globs and the `.paws/high-risk-paths` file at `base`.
 */
export async function classifyPathsRisk(input: {
  git: RiskGit;
  base: string;
  changed: readonly string[];
  settingsGlobs: readonly string[];
}): Promise<RiskClassification> {
  const fileGlobs = await baseFileGlobs(input.git, input.base);
  return classifyRisk(input.changed, [...input.settingsGlobs, ...fileGlobs]);
}

async function baseFileGlobs(git: RiskGit, base: string): Promise<string[]> {
  const listed = await git(["ls-tree", "-z", base, "--", HIGH_RISK_PATHS_FILE]);
  if (!listed.startsWith("100")) return [];
  const text = await git(["cat-file", "blob", `${base}:${HIGH_RISK_PATHS_FILE}`]);
  return parseHighRiskPathsFile(text.slice(0, HIGH_RISK_PATHS_FILE_MAX_BYTES));
}
