import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { journalCaught } from "../journal";
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
    GIT_NO_LAZY_FETCH: "1",
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

class UnusableRepositoryError extends GitCommandError {}

type Run = (argv: string[], cwd?: string) => Promise<{ stdout: string }>;

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const LOCK_POLL_MS = 100;

let publicationRoot: string | null = null;

export function usePublicationRepositories(root: string | null): void {
  publicationRoot = root;
}

function persistentRepository(root: string | null, remote: string): string | undefined {
  if (!root || path.isAbsolute(remote)) return undefined;
  const [owner, name, ...rest] = new URL(remote).pathname.split("/").filter(Boolean);
  const repo = name?.replace(/\.git$/, "");
  if (!owner || !repo || rest.length || !SAFE_SEGMENT.test(owner) || !SAFE_SEGMENT.test(repo))
    return undefined;
  return path.join(root, owner, `${repo}.git`);
}

const queues = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(fn);
  const tail = next.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return next;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function lockRepository(
  repository: string,
  signal?: AbortSignal,
): Promise<{ stale: boolean; release: () => Promise<void> }> {
  const lock = `${repository}.lock`;
  let stale = false;
  for (;;) {
    signal?.throwIfAborted();
    try {
      await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
      return { stale, release: () => rm(lock, { force: true }) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = Number(await readFile(lock, "utf8").catch(() => ""));
    if (holder > 0 && holder !== process.pid && alive(holder)) {
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
      continue;
    }
    stale = true;
    await rm(lock, { force: true });
  }
}

async function resetRepository(run: Run, repository: string): Promise<void> {
  await rm(repository, { recursive: true, force: true });
  await run(["init", "--bare", "--template=", repository]);
  await chmod(repository, 0o700);
}

async function openRepository(run: Run, repository: string, stale: boolean): Promise<void> {
  if (!stale) {
    try {
      await run(["--git-dir", repository, "rev-parse", "--git-dir"]);
      return;
    } catch (error) {
      journalCaught(error, "publication.openRepository", null, "rebuilding the repository");
    }
  }
  await resetRepository(run, repository);
}

async function knownCommits(run: Run, repository: string): Promise<string[]> {
  const format = "%(objecttype) %(objectname) %(*objecttype) %(*objectname)";
  const { stdout } = await run([
    "--git-dir",
    repository,
    "for-each-ref",
    `--format=${format}`,
  ]).catch((error: unknown) => {
    if (!(error instanceof GitCommandError)) throw error;
    throw new UnusableRepositoryError(error.args, error.stderr);
  });
  const commits = new Set<string>();
  for (const line of stdout.split("\n")) {
    const [type, id, peeledType, peeled] = line.split(" ");
    if (type === "commit" && id) commits.add(id);
    else if (peeledType === "commit" && peeled) commits.add(peeled);
  }
  return [...commits];
}

/**
 * A branch named `HEAD` makes the name ambiguous, and `git bundle` then leaves the checkout's HEAD
 * out, so HEAD is resolved to its commit ($GIT_DIR/HEAD wins over refs/heads/HEAD), carried in the
 * bundle by id, and the `HEAD` branch stays out of the publication repository.
 */
async function stageCandidate(
  run: Run,
  candidate: string,
  repository: string,
  bundle: string,
  known: string[],
): Promise<boolean> {
  const head = (
    await run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], candidate)
  ).stdout.trim();
  if (await partialCandidate(run, candidate)) {
    const objects = (
      await run(["rev-parse", "--path-format=absolute", "--git-path", "objects"], candidate)
    ).stdout.trim();
    await mkdir(path.join(repository, "objects", "info"), { recursive: true });
    await writeFile(path.join(repository, "objects", "info", "alternates"), `${objects}\n`);
    await run(["--git-dir", repository, "update-ref", "--no-deref", "HEAD", head]);
    return true;
  }
  const shared = known.length
    ? (await run(["rev-list", "--no-walk", "--ignore-missing", ...known], candidate)).stdout
        .split("\n")
        .filter(Boolean)
    : [];
  await rm(bundle, { force: true });
  try {
    await run(
      [
        "bundle",
        "create",
        bundle,
        `--exclude=${HEAD_BRANCH}`,
        "--branches",
        "--tags",
        head,
        ...shared.map((id) => `^${id}`),
      ],
      candidate,
    );
  } catch (error) {
    if (!(shared.length && error instanceof GitCommandError && /empty bundle/.test(error.stderr)))
      throw error;
    await run(["--git-dir", repository, "update-ref", "--no-deref", "HEAD", head]);
    return false;
  }
  try {
    await run([
      "--git-dir",
      repository,
      "fetch",
      bundle,
      "+refs/heads/*:refs/heads/*",
      "+refs/tags/*:refs/tags/*",
      `^${HEAD_BRANCH}`,
    ]);
  } catch (error) {
    if (!(error instanceof GitCommandError)) throw error;
    throw new UnusableRepositoryError(error.args, error.stderr);
  }
  await run(["--git-dir", repository, "update-ref", "--no-deref", "HEAD", head]);
  return false;
}

async function partialCandidate(run: Run, candidate: string): Promise<boolean> {
  return /^(extensions\.partialclone=.|remote\..*\.promisor=true$)/im.test(
    (await run(["config", "--list"], candidate)).stdout,
  );
}

async function stagePersistent(run: Run, candidate: string, repository: string, bundle: string) {
  try {
    await stageCandidate(run, candidate, repository, bundle, await knownCommits(run, repository));
    return;
  } catch (error) {
    if (!(error instanceof UnusableRepositoryError)) throw error;
    journalCaught(error, "publication.stageCandidate", null, "rebuilding the repository");
  }
  await resetRepository(run, repository);
  await stageCandidate(run, candidate, repository, bundle, []);
}

export function publicationExec(
  gitExec: GitExec,
  credential?: { path: string; token: string },
  root: string | null = publicationRoot,
): GitExec {
  return async (args, options) => {
    const operation = args.findIndex((arg) =>
      ["clone", "push", "fetch", "ls-remote"].includes(arg),
    );
    if (operation < 0) throw new Error("unsupported credentialed Git operation");
    const command = args[operation]!;
    const remote = args.slice(operation + 1).find((arg) => !arg.startsWith("-"));
    if (!remote) throw new Error("publication needs an explicit remote");
    publicationRemote(remote);
    const objects = args.slice(args.indexOf(remote, operation) + 1);
    const byId =
      command === "fetch" &&
      objects.length > 0 &&
      objects.every((arg) => /^[a-f0-9]{40,64}$/.test(arg));
    const call = { gitExec, credential, args, options, command, remote, operation, objects: byId };
    const persistent =
      (command === "push" || (command === "fetch" && !byId)) && persistentRepository(root, remote);
    if (!persistent) return publish(call);
    if (
      command === "push" &&
      (await partialCandidate(
        (argv, cwd) => gitExec(argv, { cwd: cwd ?? options.cwd, env: publicationEnv(options.env) }),
        options.cwd,
      ))
    )
      return publish(call);
    await mkdir(path.dirname(persistent), { recursive: true, mode: 0o700 });
    return serialized(persistent, async () => {
      const lock = await lockRepository(persistent, options.signal);
      try {
        return await publish(call, { repository: persistent, stale: lock.stale });
      } finally {
        await lock.release();
      }
    });
  };
}

async function publish(
  call: {
    gitExec: GitExec;
    credential?: { path: string; token: string };
    args: string[];
    options: Parameters<GitExec>[1];
    command: string;
    remote: string;
    operation: number;
    objects: boolean;
  },
  persistent?: { repository: string; stale: boolean },
): Promise<{ stdout: string; stderr: string }> {
  const { gitExec, credential, args, options, command, remote, operation } = call;
  const dir = await mkdtemp(path.join(tmpdir(), "paws-publication-"));
  const repository = persistent?.repository ?? path.join(dir, "repo.git");
  const bundle = path.join(dir, "candidate.bundle");
  const commandArgs =
    persistent && command === "fetch"
      ? [
          ...args.slice(0, args.indexOf("fetch") + 1),
          "--prune",
          ...args.slice(args.indexOf("fetch") + 1),
        ]
      : args;
  let publicationArgs = command === "clone" ? args : ["--git-dir", repository, ...commandArgs];
  const env = publicationEnv(options.env);
  env.HOME = dir;
  const run: Run = (argv, cwd = dir) => gitExec(argv, { cwd, env, signal: options.signal });
  try {
    if (persistent) await openRepository(run, repository, persistent.stale);
    else if (command !== "clone") await run(["init", "--bare", "--template=", repository]);
    if (command === "push") {
      try {
        if (persistent) await stagePersistent(run, options.cwd, repository, bundle);
        else if (await stageCandidate(run, options.cwd, repository, bundle, []))
          publicationArgs = publicationArgs.toSpliced(operation + 3, 0, "--no-thin");
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
    if (call.objects) {
      await run(["--git-dir", repository, "config", "uploadpack.allowAnySHA1InWant", "true"]);
      await run(
        [
          "fetch",
          "--no-tags",
          "--no-write-fetch-head",
          "--recurse-submodules=no",
          repository,
        ].concat(args.slice(args.indexOf(remote, operation) + 1)),
        options.cwd,
      );
    } else if (command === "fetch") {
      const refspec = args.at(-1);
      const ref = refspec?.split(":")[1];
      if (!ref) throw new Error("publication fetch needs an explicit destination ref");
      await run(["fetch", "--prune", repository, `+${ref}:${ref}`], options.cwd);
    }
    if (persistent && command === "push")
      await run([
        "--git-dir",
        repository,
        "-c",
        "gc.autoDetach=false",
        "gc",
        "--auto",
        "--quiet",
      ]).catch((error: unknown) =>
        journalCaught(error, "publication.gc", null, "housekeeping retries after the next push"),
      );
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
