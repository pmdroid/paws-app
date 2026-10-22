import { loadConfigFile } from "../config";
import { checkoutPatterns, exclusionPatterns } from "../worktree-checkout";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { git } from "./git";
import { branchName, mirrorPath, worktreePath } from "./paths";

const TRACKING_REF = "+refs/heads/*:refs/remotes/origin/*";
const START_REFS = ["origin/main", "main", "origin/master", "HEAD"] as const;

export interface Mirror {
  path: string;
  owner: string;
  repo: string;
}

export interface Worktree {
  path: string;
  branch: string;
  mirrorPath: string;
  itemId: string;
  startRef: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function revParse(gitDir: string, ref: string): Promise<string | undefined> {
  try {
    const sha = (await git(["--git-dir", gitDir, "rev-parse", "--verify", "--quiet", ref])).trim();
    return sha || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Bare clone under `~/.paws/repos/<owner>/<repo>.git`.
 *
 * Fetch stores remote branches at `origin/*` so a worktree can be added from
 * `origin/main` without moving a branch that is already checked out.
 */
const mirrorRefreshes = new Map<string, Promise<unknown>>();

export async function ensureBareMirror(options: {
  remoteUrl: string;
  owner: string;
  repo: string;
  pawsRoot: string;
  networkGit?: (args: string[]) => Promise<string>;
}): Promise<Mirror> {
  const path = mirrorPath(options.pawsRoot, options.owner, options.repo);
  const previous = mirrorRefreshes.get(path) ?? Promise.resolve();
  const refresh = previous.catch(() => undefined).then(() => refreshMirror(path, options));
  mirrorRefreshes.set(path, refresh);
  try {
    return await refresh;
  } finally {
    if (mirrorRefreshes.get(path) === refresh) mirrorRefreshes.delete(path);
  }
}

async function refreshMirror(
  path: string,
  options: Parameters<typeof ensureBareMirror>[0],
): Promise<Mirror> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await mkdir(options.pawsRoot, { recursive: true, mode: 0o700 });

  if (!(await exists(path))) {
    await (options.networkGit ?? git)(["clone", "--bare", options.remoteUrl, path]);
  } else {
    const current = (await git(["--git-dir", path, "remote", "get-url", "origin"])).trim();
    if (current !== options.remoteUrl) {
      await git(["--git-dir", path, "remote", "set-url", "origin", options.remoteUrl]);
    }
  }

  await git(["--git-dir", path, "config", "remote.origin.fetch", TRACKING_REF]);
  try {
    await (options.networkGit ?? git)([
      "--git-dir",
      path,
      "fetch",
      "--prune",
      options.remoteUrl,
      TRACKING_REF,
    ]);
  } catch (error) {
    if (options.networkGit) throw error;
    const cached = await resolveStartRef(path);
    if (!cached) throw error;
  }

  return { path, owner: options.owner, repo: options.repo };
}

export async function resolveStartRef(
  gitDir: string,
  preferred?: string,
): Promise<string | undefined> {
  const candidates = preferred ? [preferred, ...START_REFS] : [...START_REFS];
  const seen = new Set<string>();
  for (const ref of candidates) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    if (await revParse(gitDir, ref)) return ref;
  }
  return undefined;
}

/**
 * `git worktree add ~/.paws/worktrees/<item> -b paws/<item> origin/main`.
 * An existing worktree for the item is reused. The caller's checkout is never used.
 */
export async function createWorktree(options: {
  owner: string;
  repo: string;
  itemId: string;
  pawsRoot: string;
  startRef?: string;
}): Promise<Worktree> {
  const gitDir = mirrorPath(options.pawsRoot, options.owner, options.repo);
  if (!(await exists(gitDir))) {
    throw new Error(`bare mirror is missing at ${gitDir}; call ensureBareMirror first`);
  }
  const path = worktreePath(options.pawsRoot, options.itemId);
  const branch = branchName(options.itemId);
  const config = loadConfigFile(join(options.pawsRoot, "config.toml"));
  const patterns = exclusionPatterns(
    config.checkoutProjects?.[`${options.owner}/${options.repo}`.toLowerCase()]?.exclude ?? [],
  );
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  if (await isRegisteredWorktree(gitDir, path)) {
    await checkoutPatterns(path, patterns);
    const startRef = (await resolveStartRef(gitDir, options.startRef)) ?? "HEAD";
    return { path, branch, mirrorPath: gitDir, itemId: options.itemId, startRef };
  }
  if (await exists(path)) {
    throw new Error(`worktree path ${path} already exists and is not a worktree of ${gitDir}`);
  }

  const startRef = await resolveStartRef(gitDir, options.startRef);
  if (!startRef) {
    throw new Error(`mirror ${gitDir} has no origin/main, main, or HEAD to branch from`);
  }

  if (await revParse(gitDir, branch)) {
    await git(["--git-dir", gitDir, "worktree", "add", "--no-checkout", path, branch]);
  } else {
    await git([
      "--git-dir",
      gitDir,
      "worktree",
      "add",
      "--no-checkout",
      "-b",
      branch,
      path,
      startRef,
    ]);
  }

  try {
    await checkoutPatterns(path, patterns);
  } catch (error) {
    await git(["--git-dir", gitDir, "worktree", "remove", "--force", path]).catch(() => undefined);
    throw error;
  }
  return { path, branch, mirrorPath: gitDir, itemId: options.itemId, startRef };
}

export async function removeWorktree(options: {
  owner: string;
  repo: string;
  itemId: string;
  pawsRoot: string;
}): Promise<void> {
  const gitDir = mirrorPath(options.pawsRoot, options.owner, options.repo);
  const path = worktreePath(options.pawsRoot, options.itemId);
  if (!(await exists(gitDir)) || !(await exists(path))) return;
  await git(["--git-dir", gitDir, "worktree", "remove", "--force", path]);
}

export async function worktreeMergedInto(path: string, heads: readonly string[]): Promise<boolean> {
  if (heads.length === 0) return false;
  const status = await git(["-C", path, "status", "--porcelain"]).catch(() => null);
  if (status === null || status.trim()) return false;
  for (const head of heads) {
    const contained = await git(["-C", path, "merge-base", "--is-ancestor", "HEAD", head]).then(
      () => true,
      () => false,
    );
    if (contained) return true;
  }
  return false;
}

async function isRegisteredWorktree(gitDir: string, path: string): Promise<boolean> {
  const listed = await git(["--git-dir", gitDir, "worktree", "list", "--porcelain"]);
  const resolved = path.endsWith("/") ? path.slice(0, -1) : path;
  return listed.split("\n").some((line) => line === `worktree ${resolved}`);
}
