import { statfsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { HostDiskFullError, isDiskFullText } from "../core";
import { journal, journalCaught } from "../journal";
import { gitTempDirectory } from "./temp";
import { GitCommandError, type GitExec } from "./types";

/** A branch literally named `HEAD`, which some repositories carry by accident. */
const HEAD_BRANCH = "refs/heads/HEAD";
/** Where a candidate pushed from a named ref lands in the publication repository. */
const STAGED_CANDIDATE = "refs/paws/staged-candidate";

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
 * Copying the candidate into the private publication repository failed, before any network push,
 * for a reason other than a full disk. Retrying cannot help, and GitHub was not involved.
 */
class PublicationStagingError extends GitCommandError {
  constructor(args: string[], stderr: string) {
    super(args, `${PUBLICATION_STAGING_FAILURE}: ${stderr.trim() || "git failed"}`);
    this.name = "PublicationStagingError";
  }
}

class UnusableRepositoryError extends GitCommandError {}

function hostDiskFull(paths: readonly string[], stderr: string, cause: unknown): HostDiskFullError {
  let fullest: { path: string; freeBytes: number } | null = null;
  for (const at of paths) {
    try {
      const stats = statfsSync(at);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      if (fullest === null || freeBytes < fullest.freeBytes) fullest = { path: at, freeBytes };
    } catch {
      continue;
    }
  }
  return new HostDiskFullError(fullest?.path ?? null, fullest?.freeBytes ?? null, stderr, {
    cause,
  });
}

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

function abortable(waiting: Promise<unknown>, signal?: AbortSignal): Promise<unknown> {
  if (!signal) return waiting;
  return Promise.race([
    waiting,
    new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  ]);
}

function serialized<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = abortable(previous, signal).then(fn);
  const tail = previous.then(() => next.catch(() => undefined));
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
 *
 * A `source` other than HEAD names the candidate in a shared bare mirror, such as
 * `refs/paws/candidates/<item>`: the bundle carries that ref alone, not every branch the mirror has.
 */
async function stageCandidate(
  run: Run,
  candidate: string,
  repository: string,
  bundle: string,
  known: string[],
  source = "HEAD",
): Promise<boolean> {
  const head = (
    await run(["rev-parse", "--verify", "--quiet", `${source}^{commit}`], candidate)
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
  const named =
    source === "HEAD" &&
    !(await run(["for-each-ref", "--format=%(refname)", HEAD_BRANCH], candidate)).stdout.trim();
  await rm(bundle, { force: true });
  try {
    await run(
      [
        "bundle",
        "create",
        bundle,
        ...(source === "HEAD"
          ? [`--exclude=${HEAD_BRANCH}`, "--branches", "--tags", named ? "HEAD" : head]
          : [source]),
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
  const carried =
    named &&
    (await run(["bundle", "list-heads", bundle], candidate)).stdout
      .split("\n")
      .some((line) => line.endsWith(" HEAD"));
  try {
    await run([
      "--git-dir",
      repository,
      "fetch",
      bundle,
      ...(source === "HEAD"
        ? [
            "+refs/heads/*:refs/heads/*",
            "+refs/tags/*:refs/tags/*",
            `^${HEAD_BRANCH}`,
            ...(carried ? [`+HEAD:${STAGED_CANDIDATE}`] : []),
          ]
        : [`+${source}:${STAGED_CANDIDATE}`]),
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

async function promisorRemote(
  run: Run,
  destination: string,
): Promise<{ url: string; filter: string } | undefined> {
  const config = async (...query: string[]) => {
    try {
      return (await run(["config", ...query], destination)).stdout.trim();
    } catch (error) {
      if (!(error instanceof GitCommandError)) throw error;
      return "";
    }
  };
  if ((await config("--bool", "--get", "remote.origin.promisor")) !== "true") return undefined;
  const [url] = (await config("--get-all", "remote.origin.url")).split("\n");
  if (!url) return undefined;
  return {
    url,
    filter: (await config("--get", "remote.origin.partialclonefilter")) || "blob:none",
  };
}

async function stagePersistent(
  run: Run,
  candidate: string,
  repository: string,
  bundle: string,
  source: string,
  target: string | undefined,
) {
  try {
    await stageCandidate(
      run,
      candidate,
      repository,
      bundle,
      await knownCommits(run, repository),
      source,
    );
    return;
  } catch (error) {
    const missing =
      error instanceof GitCommandError
        ? /nonexistent object ([0-9a-f]{40,64})/.exec(error.stderr)?.[1]
        : undefined;
    if (missing)
      journal(
        `publication: ${target ?? "candidate"} staged ${missing}, an object the publication repository lacks; rebuilding it and staging once more`,
      );
    else if (error instanceof UnusableRepositoryError)
      journalCaught(error, "publication.stageCandidate", null, "rebuilding the repository");
    else throw error;
  }
  await resetRepository(run, repository);
  await stageCandidate(run, candidate, repository, bundle, [], source);
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
    return serialized(
      persistent,
      async () => {
        const lock = await lockRepository(persistent, options.signal);
        try {
          return await publish(call, { repository: persistent, stale: lock.stale });
        } finally {
          await lock.release();
        }
      },
      options.signal,
    );
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
  const dir = await gitTempDirectory("paws-publication-");
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
  // The pushed refspec names the candidate in the caller's repository; staged, it is HEAD here.
  const pushed = command === "push" ? args.at(-1)?.split(":") : undefined;
  const source = pushed?.length === 2 && pushed[0]?.startsWith("refs/") ? pushed[0] : "HEAD";
  if (source !== "HEAD") publicationArgs = [...publicationArgs.slice(0, -1), `HEAD:${pushed![1]}`];
  const env = publicationEnv(options.env);
  env.HOME = dir;
  const run: Run = (argv, cwd = dir) => gitExec(argv, { cwd, env, signal: options.signal });
  try {
    if (persistent) await openRepository(run, repository, persistent.stale);
    else if (command !== "clone") await run(["init", "--bare", "--template=", repository]);
    if (command === "push") {
      try {
        if (persistent)
          await stagePersistent(
            run,
            options.cwd,
            repository,
            bundle,
            source,
            pushed?.at(-1)?.replace(/^refs\/heads\//, ""),
          );
        else if (await stageCandidate(run, options.cwd, repository, bundle, [], source))
          publicationArgs = publicationArgs.toSpliced(operation + 3, 0, "--no-thin");
      } catch (error) {
        const stderr = error instanceof GitCommandError ? error.stderr : String(error);
        if (isDiskFullText(stderr)) throw hostDiskFull([dir, repository], stderr, error);
        throw new PublicationStagingError(
          error instanceof GitCommandError ? error.args : [],
          stderr,
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
      const promisor = await promisorRemote(run, options.cwd);
      if (!promisor) await run(["fetch", "--prune", repository, `+${ref}:${ref}`], options.cwd);
      else {
        await run(["--git-dir", repository, "config", "uploadpack.allowFilter", "true"]);
        await run(
          [
            "-c",
            `url.${repository}.insteadOf=${promisor.url}`,
            "fetch",
            `--filter=${promisor.filter}`,
            "--upload-pack=git-upload-pack",
            "--prune",
            "origin",
            `+${ref}:${ref}`,
          ],
          options.cwd,
        );
      }
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
