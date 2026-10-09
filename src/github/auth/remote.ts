import { defaultGitExec, gitEnv } from "../git";
import type { GitExec } from "../types";

const NAME = /^[A-Za-z0-9._-]+$/;

export function parseGitHubRemote(remoteUrl: string): { owner: string; repo: string } {
  const url = remoteUrl.trim();
  const path = githubPath(url);
  if (!path) {
    throw new Error(`remote is not a GitHub repository URL: ${redactRemote(url)}`);
  }
  const [owner, repo] = path;
  if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo)) {
    throw new Error(`remote is not a GitHub repository URL: ${redactRemote(url)}`);
  }
  return { owner, repo };
}

/**
 * Owner and repo for the configured repository.
 * `PAWS_GITHUB_REPOSITORY` wins. Otherwise the local git remote is parsed.
 */
export async function inferGitHubRepository(input: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  remote?: string;
  gitExec?: GitExec;
}): Promise<{ owner: string; repo: string }> {
  const env = input.env ?? process.env;
  const configured = env.PAWS_GITHUB_REPOSITORY;
  if (configured !== undefined && configured.length > 0) {
    return parseOwnerRepo(configured);
  }
  const remote = input.remote ?? "origin";
  const gitExec = input.gitExec ?? defaultGitExec();
  let url = "";
  try {
    const result = await gitExec(["remote", "get-url", remote], {
      cwd: input.cwd,
      env: gitEnv(),
    });
    url = result.stdout.trim();
  } catch (error) {
    throw new Error(`PAWS_GITHUB_REPOSITORY is unset and git remote ${remote} could not be read`, {
      cause: error,
    });
  }
  if (url === "") {
    throw new Error(`PAWS_GITHUB_REPOSITORY is unset and git remote ${remote} is empty`);
  }
  return parseGitHubRemote(url);
}

function parseOwnerRepo(value: string): { owner: string; repo: string } {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  const owner = slash === -1 ? "" : trimmed.slice(0, slash);
  const repo = slash === -1 ? "" : trimmed.slice(slash + 1);
  if (!NAME.test(owner) || !NAME.test(repo) || repo.includes("/")) {
    throw new Error("PAWS_GITHUB_REPOSITORY must be owner/repo");
  }
  return { owner, repo };
}

function githubPath(url: string): [string, string] | null {
  const scp = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(url);
  if (scp?.[1] && scp[2]) return [scp[1], scp[2]];
  const web =
    /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
      url,
    );
  if (web?.[1] && web[2]) return [web[1], web[2]];
  return null;
}

function redactRemote(url: string): string {
  return url.replace(/\/\/[^/\s@]+@/g, "//");
}
