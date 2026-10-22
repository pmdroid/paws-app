import { z } from "zod";
import { repoApiPath } from "./client";
import { git, gitEnv } from "./git";
import { UPSTREAM_MAIN_REF, type GitExec, type GitHubClient } from "./types";

export type MainOverlap = {
  /** The commit main and the pull request share. */
  base: string;
  /** Files, or package roots, that both main and the pull request changed. */
  shared: string[];
};

/**
 * Compare the files main changed since the pull request's base with the files the pull request
 * changes. With package roots such as `apps/*`, a change anywhere in the same package overlaps.
 */
export async function mainOverlap(
  worktree: string,
  packages: readonly string[],
  gitExec: GitExec,
): Promise<MainOverlap> {
  const base = await git(worktree, ["merge-base", "HEAD", UPSTREAM_MAIN_REF], gitExec);
  // Untrimmed, so a file name keeps its spaces.
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

/** The files, or the package roots, both lists touch. Sorted. */
export function overlappingPaths(
  pull: readonly string[],
  main: readonly string[],
  packages: readonly string[] = [],
): string[] {
  const key = (file: string) => packageRoot(file, packages) ?? file;
  const touched = new Set(pull.map(key));
  return [...new Set(main.map(key).filter((entry) => touched.has(entry)))].sort();
}

/**
 * The package a file belongs to: the first root pattern that matches a leading part of its path.
 * `*` matches one path segment, so `apps/*` puts `apps/web/src/a.ts` in `apps/web`.
 */
export function packageRoot(file: string, packages: readonly string[]): string | null {
  const segments = file.split("/");
  for (const pattern of packages) {
    const parts = pattern.replace(/\/+$/, "").split("/");
    // A package holds files below its root, not the root itself.
    if (parts.length === 0 || segments.length <= parts.length) continue;
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

/**
 * Whether GitHub requires branches to be up to date before merging into `branch`: the rulesets,
 * the branch protection when this token can read it, and the pull request's `behind` state.
 * `null` when none of them could be read.
 */
export async function readUpToDateRule(input: {
  client: GitHubClient;
  token: string;
  owner: string;
  repo: string;
  branch: string;
  prNumber: number;
}): Promise<boolean | null> {
  const encoded = input.branch.split("/").map(encodeURIComponent).join("/");
  const get = (suffix: string) =>
    input.client.request({
      method: "GET",
      path: repoApiPath(input.owner, input.repo, suffix),
      token: input.token,
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
  // Branch protection needs administration read; an App without it gets 403 or 404.
  const protection = await get(`/branches/${encoded}/protection/required_status_checks`);
  const strict = strictSchema.safeParse(protection.body);
  if (protection.status === 200 && strict.success) {
    if (strict.data.strict === true) return true;
    read = true;
  }
  // GitHub reports `behind` only when the rule is on and the branch is behind.
  const pull = await get(`/pulls/${input.prNumber}`);
  const state = pullSchema.safeParse(pull.body);
  if (pull.status === 200 && state.success) {
    if (state.data.mergeable_state === "behind") return true;
    read = true;
  }
  return read ? false : null;
}
