import { journalCaught } from "../journal";
import { z } from "zod";
import { repoApiPath } from "./client";
import { git, gitEnv } from "./git";
import { UPSTREAM_MAIN_REF, type GitExec, type GitHubClient } from "./types";

export type MainOverlap = { base: string; shared: string[] };

export async function mainOverlap(
  worktree: string,
  packages: readonly string[],
  gitExec: GitExec,
): Promise<MainOverlap> {
  const base = await git(worktree, ["merge-base", "HEAD", UPSTREAM_MAIN_REF], gitExec);
  const changed = async (to: string) =>
    (
      await gitExec(["diff", "--name-only", "--no-renames", "-z", base, to, "--"], {
        cwd: worktree,
        env: gitEnv(),
      })
    ).stdout
      .split("\0")
      .filter((file) => file !== "");
  const [onMain, inPull] = await Promise.all([changed(UPSTREAM_MAIN_REF), changed("HEAD")]);
  return { base, shared: overlappingPaths(inPull, onMain, packages) };
}

export function overlappingPaths(
  pull: readonly string[],
  main: readonly string[],
  packages: readonly string[] = [],
): string[] {
  const key = (file: string) => packageRoot(file, packages) ?? file;
  const touched = new Set(pull.map(key));
  return [...new Set(main.map(key).filter((entry) => touched.has(entry)))].sort();
}

export function packageRoot(file: string, packages: readonly string[]): string | null {
  const segments = file.split("/");
  for (const pattern of packages) {
    const parts = pattern.replace(/\/+$/, "").split("/");
    if (segments.length <= parts.length) continue;
    if (parts.every((part, index) => part === "*" || part === segments[index]))
      return segments.slice(0, parts.length).join("/");
  }
  return null;
}

const rulesSchema = z.array(
  z.object({
    type: z.string(),
    parameters: z
      .object({ strict_required_status_checks_policy: z.boolean().optional() })
      .passthrough()
      .nullable()
      .optional(),
  }),
);
const strictSchema = z.object({ strict: z.boolean().optional() });
const pullSchema = z.object({ mergeable_state: z.string().optional() });

export async function readUpToDateRule(input: {
  client: GitHubClient;
  token: string;
  owner: string;
  repo: string;
  branch: string;
  prNumber?: number;
  signal?: AbortSignal;
}): Promise<boolean | null> {
  const encoded = input.branch.split("/").map(encodeURIComponent).join("/");
  const get = (suffix: string) =>
    input.client.request({
      method: "GET",
      path: repoApiPath(input.owner, input.repo, suffix),
      token: input.token,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  let read = false;
  for (let page = 1; page <= 10; page++) {
    const response = await get(`/rules/branches/${encoded}?per_page=100&page=${page}`);
    const rules = rulesSchema.safeParse(response.body);
    if (response.status !== 200 || !rules.success) break;
    read = true;
    if (
      rules.data.some(
        (rule) =>
          rule.type === "required_status_checks" &&
          rule.parameters?.strict_required_status_checks_policy === true,
      )
    )
      return true;
    if (rules.data.length < 100) break;
  }
  const protection = await get(`/branches/${encoded}/protection/required_status_checks`);
  const strict = strictSchema.safeParse(protection.body);
  if (protection.status === 200 && strict.success) {
    if (strict.data.strict === true) return true;
    read = true;
  }
  if (input.prNumber !== undefined) {
    const pull = await get(`/pulls/${input.prNumber}`);
    const state = pullSchema.safeParse(pull.body);
    if (pull.status === 200 && state.success) {
      if (state.data.mergeable_state === "behind") return true;
      read = true;
    }
  }
  return read ? false : null;
}

export async function repositoriesRequiringUpToDate<
  R extends { owner: string; repo: string },
>(input: {
  repositories: readonly R[];
  token: (repository: R) => Promise<string | null>;
  client: GitHubClient;
  signal?: AbortSignal;
}): Promise<string[]> {
  const required = await Promise.all(
    input.repositories.map(async (repository) => {
      const token = await input.token(repository).catch((caughtError1) => {
        journalCaught(caughtError1, "overlap.repositoriesRequiringUpToDate.token", null);
        return null;
      });
      if (token === null) return false;
      return readUpToDateRule({
        client: input.client,
        token,
        owner: repository.owner,
        repo: repository.repo,
        branch: "main",
        ...(input.signal ? { signal: input.signal } : {}),
      }).catch((caughtError2) => {
        journalCaught(caughtError2, "overlap.repositoriesRequiringUpToDate.readUpToDateRule", null);
        return false;
      });
    }),
  );
  return input.repositories
    .filter((_, index) => required[index] === true)
    .map((repository) => `${repository.owner}/${repository.repo}`);
}
