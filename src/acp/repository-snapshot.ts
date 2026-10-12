import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { git } from "./git";
import { resolveStartRef } from "./worktree";

export async function prepareRepositorySnapshot(options: {
  owner: string;
  repo: string;
  remoteUrl: string;
  workspace: string;
  signal: AbortSignal;
  onCleanupFailure?: () => void;
}): Promise<{ path: string; commit: string }> {
  options.signal.throwIfAborted();
  const path = join(options.workspace, "repository");
  const metadataPath = `${options.workspace}.repository.json`;
  try {
    const saved = JSON.parse(await readFile(metadataPath, "utf8")) as {
      owner: string;
      repo: string;
      commit: string;
    };
    if (saved.owner !== options.owner || saved.repo !== options.repo)
      throw new Error("Repository snapshot ownership changed");
    if (!(await lstat(path)).isDirectory())
      throw new Error("Repository snapshot is not a directory");
    options.signal.throwIfAborted();
    return { path, commit: saved.commit };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(options.workspace, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(dirname(options.workspace), ".repository-"));
  try {
    const gitOptions = { signal: options.signal, onCleanupFailure: options.onCleanupFailure };
    const mirror = join(staging, "mirror.git");
    await git(["clone", "--bare", "--", options.remoteUrl, mirror], gitOptions);
    const ref = await resolveStartRef(mirror);
    if (!ref) throw new Error("The repository has no source commit");
    const commit = (await git(["--git-dir", mirror, "rev-parse", ref], gitOptions)).trim();
    const archive = join(staging, "source.tar");
    await git(
      ["--git-dir", mirror, "archive", "--format=tar", `--output=${archive}`, commit],
      gitOptions,
    );
    const tree = join(staging, "tree");
    await mkdir(tree, { mode: 0o700 });
    await promisify(execFile)("tar", ["-xf", archive, "-C", tree], { signal: options.signal });
    options.signal.throwIfAborted();
    const metadata = join(staging, "metadata.json");
    await writeFile(
      metadata,
      JSON.stringify({ owner: options.owner, repo: options.repo, commit }),
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
