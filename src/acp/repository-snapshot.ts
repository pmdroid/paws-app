import { journalCaught } from "../journal";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { exclusionPatterns } from "../worktree-checkout";
import { git } from "./git";
import { resolveStartRef } from "./worktree";

export async function prepareRepositorySnapshot(options: {
  checkoutExclusions?: readonly string[];
  owner: string;
  repo: string;
  remoteUrl: string;
  workspace: string;
  signal: AbortSignal;
  commit?: string;
  env?: NodeJS.ProcessEnv;
  maxArchiveBytes?: number;
  onCleanupFailure?: () => void;
  networkGit?: (args: string[]) => Promise<string>;
}): Promise<{ path: string; commit: string }> {
  options.signal.throwIfAborted();
  const checkoutExclusions = [...new Set(options.checkoutExclusions ?? [])].sort();
  exclusionPatterns(checkoutExclusions);
  if (options.commit !== undefined && !/^[a-f0-9]{40}$/.test(options.commit))
    throw new Error("Invalid snapshot commit");
  if (
    options.maxArchiveBytes !== undefined &&
    (!Number.isSafeInteger(options.maxArchiveBytes) || options.maxArchiveBytes <= 0)
  )
    throw new Error("Invalid snapshot archive limit");
  const path = join(options.workspace, "repository");
  const metadataPath = `${options.workspace}.repository.json`;
  try {
    const saved = JSON.parse(await readFile(metadataPath, "utf8")) as {
      owner: string;
      repo: string;
      commit: string;
      checkoutExclusions?: string[];
    };
    if (
      saved.owner !== options.owner ||
      saved.repo !== options.repo ||
      JSON.stringify(saved.checkoutExclusions ?? []) !== JSON.stringify(checkoutExclusions) ||
      (options.commit !== undefined && saved.commit !== options.commit)
    )
      throw new Error("Repository snapshot ownership changed");
    if (!(await lstat(path)).isDirectory())
      throw new Error("Repository snapshot is not a directory");
    options.signal.throwIfAborted();
    return { path, commit: saved.commit };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    journalCaught(
      error,
      "repository-snapshot.prepareRepositorySnapshot.parse",
      null,
      "optional file may be absent",
    );
  }
  await mkdir(options.workspace, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(dirname(options.workspace), ".repository-"));
  try {
    const gitOptions = {
      signal: options.signal,
      env: options.env,
      onCleanupFailure: options.onCleanupFailure,
    };
    const mirror = join(staging, "mirror.git");
    const clone = ["clone", "--bare", "--", options.remoteUrl, mirror];
    if (options.networkGit) await options.networkGit(clone);
    else await git(clone, gitOptions);
    const ref = options.commit ?? (await resolveStartRef(mirror));
    if (!ref) throw new Error("The repository has no source commit");
    const commit = (
      await git(["--git-dir", mirror, "rev-parse", "--verify", `${ref}^{commit}`], gitOptions)
    ).trim();
    if (options.commit !== undefined && commit !== options.commit)
      throw new Error("Snapshot commit is unavailable");
    const archive = join(staging, "source.tar");
    await git(
      [
        "--git-dir",
        mirror,
        "archive",
        "--format=tar",
        `--output=${archive}`,
        commit,
        "--",
        ".",
        ...checkoutExclusions.map((folder) => `:(top,exclude,literal)${folder}`),
      ],
      gitOptions,
    );
    if (
      options.maxArchiveBytes !== undefined &&
      (await stat(archive)).size > options.maxArchiveBytes
    )
      throw new Error("Snapshot archive exceeds size limit");
    const tree = join(staging, "tree");
    await mkdir(tree, { mode: 0o700 });
    await promisify(execFile)("tar", ["-xf", archive, "-C", tree], {
      signal: options.signal,
      env: options.env,
    });
    options.signal.throwIfAborted();
    const metadata = join(staging, "metadata.json");
    await writeFile(
      metadata,
      JSON.stringify({ owner: options.owner, repo: options.repo, commit, checkoutExclusions }),
      {
        mode: 0o600,
      },
    );
    await rename(metadata, metadataPath);
    options.signal.throwIfAborted();
    await rename(tree, path);
    return { path, commit };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
