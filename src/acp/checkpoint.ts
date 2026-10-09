import { git } from "./git";

export interface CheckpointResult {
  committed: boolean;
  sha?: string;
  message: string;
}

const COMMIT_ENV_DEFAULTS = {
  GIT_AUTHOR_NAME: "Paws",
  GIT_AUTHOR_EMAIL: "paws@localhost",
  GIT_COMMITTER_NAME: "Paws",
  GIT_COMMITTER_EMAIL: "paws@localhost",
};

/**
 * Commit whatever is dirty in the item worktree. A clean tree is left as it is.
 * Hooks are skipped so a cancel or timeout still records the checkpoint.
 */
export async function commitCheckpoint(
  worktreePath: string,
  message = "wip: checkpoint",
): Promise<CheckpointResult> {
  const status = (await git(["-C", worktreePath, "status", "--porcelain"])).trim();
  if (!status) return { committed: false, message };

  await git(["-C", worktreePath, "add", "-A"]);
  const env = { ...process.env, ...COMMIT_ENV_DEFAULTS };
  await git(
    [
      "-C",
      worktreePath,
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Paws",
      "-c",
      "user.email=paws@localhost",
      "commit",
      "--no-verify",
      "-m",
      message,
    ],
    { env },
  );
  const sha = (await git(["-C", worktreePath, "rev-parse", "HEAD"])).trim();
  return { committed: true, sha, message };
}
