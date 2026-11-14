import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { candidateRef, mirrorPath, type RunAgentOptions, type RunAgentResult } from "../src/acp";
import { openPawsStore, type Db } from "../src/db";
import { pawsPaths } from "../src/config";
import { copyMigratedPglite } from "./pglite";
import { writeStoredToken, type StoredLinearToken } from "../src/linear";

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "paws-"));
}

/**
 * A runner-backed item's head on the control plane: the bare mirror under `pawsRoot` for the
 * repository, holding `source`'s history, with the item's candidate ref at `source`'s HEAD.
 * `head()` reads the ref, and `adopt()` points it at `source`'s HEAD again.
 */
export function seedCandidate(
  pawsRoot: string,
  itemId: string,
  source: string,
  repository: { owner: string; repo: string } = { owner: "fixture", repo: "repository" },
) {
  const mirror = mirrorPath(pawsRoot, repository.owner, repository.repo);
  const ref = candidateRef(itemId);
  const git = (args: string[]) => {
    const child = Bun.spawnSync(["/usr/bin/git", ...args], {
      env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    return child.stdout.toString().trim();
  };
  if (!existsSync(mirror)) {
    mkdirSync(dirname(mirror), { recursive: true });
    git(["init", "-q", "--bare", mirror]);
  }
  const adopt = () => git(["--git-dir", mirror, "fetch", "-q", source, `+HEAD:${ref}`]);
  adopt();
  return { mirror, ref, adopt, head: () => git(["--git-dir", mirror, "rev-parse", ref]) };
}

/** Where {@link cloneRunner} checks an item out, as a runner's own checkout. */
export function runnerCheckout(pawsRoot: string, itemId: string): string {
  return join(pawsRoot, "runner-checkouts", itemId);
}

/**
 * Stands in for a remote runner: runs `agent` in its own clone of the item's candidate ref, then
 * imports the clone's HEAD back into the bare mirror, as the candidate import does. The control
 * plane keeps no worktree for a runner-backed item, so a fake runner cannot use one either.
 */
export function cloneRunner(
  repository: { owner: string; repo: string },
  agent: (options: RunAgentOptions) => Promise<RunAgentResult>,
) {
  const git = (args: string[]) => {
    const child = Bun.spawnSync(["/usr/bin/git", ...args]);
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    return child.stdout.toString().trim();
  };
  return async (options: RunAgentOptions): Promise<RunAgentResult> => {
    const mirror = mirrorPath(options.pawsRoot, repository.owner, repository.repo);
    const ref = candidateRef(options.itemId);
    // Work with no candidate ref, such as an answer task, keeps the workspace it was given.
    const held = Bun.spawnSync([
      "/usr/bin/git",
      "--git-dir",
      mirror,
      "rev-parse",
      "--verify",
      "-q",
      ref,
    ]);
    if (held.exitCode !== 0) return agent(options);
    const tree = runnerCheckout(options.pawsRoot, options.itemId);
    if (!existsSync(tree)) git(["clone", "-q", "--no-checkout", mirror, tree]);
    git([
      "-C",
      tree,
      "fetch",
      "-q",
      mirror,
      `+${ref}:refs/paws/start`,
      "+refs/remotes/origin/*:refs/remotes/origin/*",
    ]);
    git(["-C", tree, "checkout", "-q", "--detach", "-f", "refs/paws/start"]);
    const result = await agent({ ...options, worktreePath: tree });
    if (options.role === "implementer")
      git(["--git-dir", mirror, "fetch", "-q", tree, `+HEAD:${ref}`]);
    return result;
  };
}

export async function migratedHome(home: string = tempHome()): Promise<string> {
  const dir = pawsPaths(home).pgliteDir;
  if (!existsSync(dir)) await copyMigratedPglite(dir);
  return home;
}

export async function withHomeStore<T>(home: string, work: (store: Db) => Promise<T>): Promise<T> {
  await migratedHome(home);
  const database = await openPawsStore({ url: null, pgliteDir: pawsPaths(home).pgliteDir });
  try {
    return await work(database.store);
  } finally {
    await database.close();
  }
}

export async function storeHomeLinearToken(home: string, token: StoredLinearToken): Promise<void> {
  await withHomeStore(home, (store) => writeStoredToken(store, join(home, "secrets"), token));
}
