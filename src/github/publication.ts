import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitCommandError, type GitExec } from "./types";

/** A branch literally named `HEAD`, which some repositories carry by accident. */
const HEAD_BRANCH = "refs/heads/HEAD";

export function publicationEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "https:file",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TEMPLATE_DIR: "/dev/null",
  };
  for (const key of [
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
  ]) {
    if (base[key] !== undefined) env[key] = base[key];
  }
  return env;
}

export function publicationRemote(url: string): void {
  if (path.isAbsolute(url)) return;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(
      "publication requires an HTTPS URL without credentials or an absolute local path",
    );
  }
}

/** Prefix of the stderr a {@link PublicationStagingError} carries, so callers that see only text know it. */
export const PUBLICATION_STAGING_FAILURE = "Paws could not stage the candidate for publication";

/**
 * Copying the candidate into the private publication repository failed, before any network push.
 * Retrying cannot help, and GitHub was not involved.
 */
class PublicationStagingError extends GitCommandError {
  constructor(args: string[], stderr: string) {
    super(args, `${PUBLICATION_STAGING_FAILURE}: ${stderr.trim() || "git failed"}`);
    this.name = "PublicationStagingError";
  }
}

/**
 * Copies the candidate's branches, tags and HEAD commit into the empty publication repository.
 * A branch named `HEAD` makes the name ambiguous, and `git bundle` then leaves the checkout's HEAD
 * out, so HEAD is resolved to its commit ($GIT_DIR/HEAD wins over refs/heads/HEAD), carried in the
 * bundle by id, and the `HEAD` branch stays out of the publication repository.
 */
async function stageCandidate(
  run: (argv: string[], cwd?: string) => Promise<{ stdout: string }>,
  candidate: string,
  repository: string,
  bundle: string,
): Promise<void> {
  const head = (
    await run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], candidate)
  ).stdout.trim();
  await run(
    ["bundle", "create", bundle, `--exclude=${HEAD_BRANCH}`, "--branches", "--tags", head],
    candidate,
  );
  await run([
    "--git-dir",
    repository,
    "fetch",
    bundle,
    "+refs/heads/*:refs/heads/*",
    "+refs/tags/*:refs/tags/*",
    `^${HEAD_BRANCH}`,
  ]);
  await run(["--git-dir", repository, "bundle", "unbundle", bundle]);
  await run(["--git-dir", repository, "update-ref", "--no-deref", "HEAD", head]);
}

export function publicationExec(
  gitExec: GitExec,
  credential?: { path: string; token: string },
): GitExec {
  return async (args, options) => {
    const operation = args.findIndex((arg) =>
      ["clone", "push", "fetch", "ls-remote"].includes(arg),
    );
    if (operation < 0) throw new Error("unsupported credentialed Git operation");
    const command = args[operation];
    const remote = args.slice(operation + 1).find((arg) => !arg.startsWith("-"));
    if (!remote) throw new Error("publication needs an explicit remote");
    publicationRemote(remote);
    const dir = await mkdtemp(path.join(tmpdir(), "paws-publication-"));
    const repository = path.join(dir, "repo.git");
    const bundle = path.join(dir, "candidate.bundle");
    const publicationArgs = command === "clone" ? args : ["--git-dir", repository, ...args];
    const env = publicationEnv(options.env);
    env.HOME = dir;
    const run = (argv: string[], cwd = dir) => gitExec(argv, { cwd, env, signal: options.signal });
    try {
      if (command !== "clone") await run(["init", "--bare", "--template=", repository]);
      if (command === "push") {
        try {
          await stageCandidate(run, options.cwd, repository, bundle);
        } catch (error) {
          throw new PublicationStagingError(
            error instanceof GitCommandError ? error.args : [],
            error instanceof GitCommandError ? error.stderr : String(error),
          );
        }
      }
      if (credential && !path.isAbsolute(remote))
        await writeFile(credential.path, credential.token, { mode: 0o600 });
      const result = await gitExec(publicationArgs, {
        cwd: dir,
        signal: options.signal,
        env: {
          ...env,
          ...(path.isAbsolute(remote) ? {} : { PAWS_GITHUB_TOKEN: options.env.PAWS_GITHUB_TOKEN }),
        },
      });
      if (credential) await rm(credential.path, { force: true });
      if (command === "fetch") {
        const refspec = args.at(-1);
        const ref = refspec?.split(":")[1];
        if (!ref) throw new Error("publication fetch needs an explicit destination ref");
        await run(["fetch", "--prune", repository, `+${ref}:${ref}`], options.cwd);
      }
      return result;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
