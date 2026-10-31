import { journalCaught } from "../journal";
import {
  assertDescendsFromAny,
  candidateBases,
  commitCoauthorTrailers,
  validateCommitAttribution,
} from "../core";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  rmSync,
  statSync,
  lstatSync,
  renameSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { defaultGitExec, runGitHubGit } from "../github";
import { RunnerCommandSchema, type RunnerCommand } from "../runner-protocol";

type WorkCommand = Extract<RunnerCommand, { type: "run" | "review" }>;
type NetworkOperation = {
  operation: "clone" | "fetch" | "push";
  remoteUrl: string;
  token: string;
  cwd: string;
  dest?: string;
  refspec?: string;
  lease?: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

const queues = new Map<string, Promise<unknown>>();

export function createRunnerRepositories(options: {
  root: string;
  home: string;
  credential(command: WorkCommand, access: "read" | "write"): Promise<string>;
  networkGit?: (input: NetworkOperation) => Promise<void>;
}) {
  if (![options.root, options.home].every(isAbsolute))
    throw new Error("Runner repository paths must be absolute");
  mkdirSync(options.root, { recursive: true, mode: 0o700 });
  const info = statSync(options.root);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700)
    throw new Error("Runner repository cache must be private");
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: options.home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const repositoryRoot = realpathSync(options.root);
  function serialize<T>(
    command: WorkCommand,
    operation: (mirror: string) => Promise<T>,
  ): Promise<T> {
    const repository = `${command.repository.owner}/${command.repository.repo}`;
    const key = join(
      repositoryRoot,
      `${createHash("sha256").update(repository.toLowerCase()).digest("hex")}.git`,
    );
    const previous = queues.get(key) ?? Promise.resolve();
    const pending = previous
      .catch((caughtError1) => {
        journalCaught(caughtError1, "runner-repositories.serialize", null);
        return undefined;
      })
      .then(() => operation(key));
    queues.set(key, pending);
    void pending
      .finally(() => {
        if (queues.get(key) === pending) queues.delete(key);
      })
      .catch((caughtError2) => {
        journalCaught(caughtError2, "runner-repositories.serialize.finally", null);
        return undefined;
      });
    return pending;
  }
  function parse(input: WorkCommand): WorkCommand {
    const command = RunnerCommandSchema.parse(input);
    if (command.type !== "run" && command.type !== "review")
      throw new Error("Repository work command is required");
    return command;
  }
  const network = options.networkGit ?? runGitHubGit;
  const execute = defaultGitExec();
  const invoke = async (args: string[], signal?: AbortSignal) =>
    (
      await execute(
        ["-c", "core.hooksPath=/dev/null", "-c", "transfer.fsckObjects=true", ...args],
        {
          cwd: options.root,
          env,
          signal,
        },
      )
    ).stdout;
  /** Runs git where its exit status and output both matter: `merge-tree` exits 1 on a conflict. */
  async function spawnGit(
    args: string[],
    input: { stdin?: string; env?: Record<string, string>; signal?: AbortSignal } = {},
  ) {
    const child = Bun.spawn(["/usr/bin/git", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd: options.root,
      env: { ...env, ...input.env },
      stdin: input.stdin === undefined ? "ignore" : new TextEncoder().encode(input.stdin),
      stdout: "pipe",
      stderr: "pipe",
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    input.signal?.throwIfAborted();
    return { code, stdout, stderr };
  }
  /**
   * Replays the first-parent commits of `head` not reachable from `excluded` onto `onto`, keeping
   * each commit's author, committer and message. A merge commit applies its change against its
   * first parent. Returns the new head, or throws {@link CandidateRebaseConflict}.
   */
  async function replay(
    mirror: string,
    head: string,
    excluded: string[],
    onto: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const commits = (
      await invoke(
        ["--git-dir", mirror, "rev-list", "--reverse", "--first-parent", head, ...excluded],
        signal,
      )
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    let current = onto;
    for (const commit of commits) {
      const merged = await spawnGit(
        [
          "--git-dir",
          mirror,
          "merge-tree",
          "--write-tree",
          "--name-only",
          "--no-messages",
          `--merge-base=${commit}^`,
          current,
          commit,
        ],
        { signal },
      );
      const [tree, ...files] = merged.stdout.split("\n").filter(Boolean);
      if (merged.code === 1) throw new CandidateRebaseConflict(files);
      if (merged.code !== 0 || !tree || !/^[a-f0-9]{40}$/.test(tree))
        throw new Error(`Runner candidate rebase failed: ${merged.stderr.trim()}`);
      // A change the branch already has leaves nothing to commit, as `git rebase` drops it.
      if (tree === (await invoke(["--git-dir", mirror, "rev-parse", `${current}^{tree}`])).trim())
        continue;
      const raw = await invoke(["--git-dir", mirror, "cat-file", "commit", commit], signal);
      const split = raw.indexOf("\n\n");
      const headers = (split === -1 ? raw : raw.slice(0, split)).split("\n");
      const person = (role: "author" | "committer") => {
        const line = headers.find((header) => header.startsWith(`${role} `));
        const match = line && /^\S+ (.*) <([^>]*)> (\d+ [+-]\d{4})$/.exec(line);
        if (!match) throw new Error(`Runner candidate commit ${commit} has no ${role}`);
        return { name: match[1]!, email: match[2]!, date: match[3]! };
      };
      const author = person("author");
      const committer = person("committer");
      const created = await spawnGit(
        ["--git-dir", mirror, "commit-tree", tree, "-p", current, "-F", "-"],
        {
          stdin: split === -1 ? "" : raw.slice(split + 2),
          env: {
            GIT_AUTHOR_NAME: author.name,
            GIT_AUTHOR_EMAIL: author.email,
            GIT_AUTHOR_DATE: author.date,
            GIT_COMMITTER_NAME: committer.name,
            GIT_COMMITTER_EMAIL: committer.email,
            GIT_COMMITTER_DATE: committer.date,
          },
          signal,
        },
      );
      current = created.stdout.trim();
      if (created.code !== 0 || !/^[a-f0-9]{40}$/.test(current))
        throw new Error(`Runner candidate rebase failed: ${created.stderr.trim()}`);
    }
    return current;
  }
  return {
    async prepare(
      input: WorkCommand,
      signal?: AbortSignal,
    ): Promise<{ mirror: string; bundle: string }> {
      const command = parse(input);
      return serialize(command, async (mirror) => {
        signal?.throwIfAborted();
        const token = await options.credential(command, "read");
        signal?.throwIfAborted();
        let exists = false;
        try {
          const directory = lstatSync(mirror);
          if (
            !directory.isDirectory() ||
            directory.uid !== process.getuid?.() ||
            (directory.mode & 0o7777) !== 0o700
          )
            throw new Error("Unsafe runner mirror");
          try {
            exists =
              (
                await invoke(["--git-dir", mirror, "rev-parse", "--is-bare-repository"], signal)
              ).trim() === "true";
          } catch (caughtError3) {
            signal?.throwIfAborted();
            journalCaught(caughtError3, "runner-repositories.prepare.trim", null);
          }
          if (!exists) rmSync(mirror, { recursive: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          journalCaught(
            error,
            "runner-repositories.prepare.lstatSync",
            null,
            "optional file may be absent",
          );
        }
        const destination = exists ? mirror : join(options.root, `clone-${randomUUID()}.git`);
        try {
          await network({
            operation: exists ? "fetch" : "clone",
            remoteUrl: command.repository.remoteUrl,
            token,
            cwd: options.root,
            dest: destination,
            env,
            signal,
          });
          signal?.throwIfAborted();
          if (!exists) {
            if (
              (
                await invoke(
                  ["--git-dir", destination, "rev-parse", "--is-bare-repository"],
                  signal,
                )
              ).trim() !== "true"
            )
              throw new Error("Runner clone is not a bare repository");
            chmodSync(destination, 0o700);
            signal?.throwIfAborted();
            renameSync(destination, mirror);
          }
        } finally {
          if (!exists) rmSync(destination, { recursive: true, force: true });
        }
        signal?.throwIfAborted();
        chmodSync(mirror, 0o700);
        const base = (
          await invoke(
            [
              "--git-dir",
              mirror,
              "rev-parse",
              "--verify",
              `${command.repository.baseSha}^{commit}`,
            ],
            signal,
          )
        ).trim();
        if (base !== command.repository.baseSha) throw new Error("Assigned base is unavailable");
        const main = command.repository.mainSha;
        if (
          main &&
          (
            await invoke(["--git-dir", mirror, "rev-parse", "--verify", `${main}^{commit}`], signal)
          ).trim() !== main
        )
          throw new Error("Assigned main is unavailable");
        const snapshot = join(
          options.root,
          `snapshot-${createHash("sha256").update(command.id).digest("hex")}.bundle`,
        );
        const ref = `refs/heads/paws-snapshot-${createHash("sha256").update(command.id).digest("hex")}`;
        try {
          const mainRef = `${ref}-main`;
          await invoke(["--git-dir", mirror, "update-ref", ref, base]);
          try {
            if (main) await invoke(["--git-dir", mirror, "update-ref", mainRef, main]);
            signal?.throwIfAborted();
            await invoke(
              ["--git-dir", mirror, "bundle", "create", snapshot, ref, ...(main ? [mainRef] : [])],
              signal,
            );
            chmodSync(snapshot, 0o600);
            if (statSync(snapshot).size > 536_870_912)
              throw new Error("Runner snapshot exceeds size limit");
            signal?.throwIfAborted();
          } finally {
            await invoke(["--git-dir", mirror, "update-ref", "-d", ref]);
            if (main) await invoke(["--git-dir", mirror, "update-ref", "-d", mainRef]);
          }
          signal?.throwIfAborted();
          return { mirror, bundle: snapshot };
        } catch (error) {
          rmSync(snapshot, { force: true });
          throw error;
        }
      });
    },
    /**
     * Pushes a candidate to its branch and returns the commit the branch now has. With `rebase`, a
     * push refused because the branch moved replays the candidate's own commits onto the new tip
     * and pushes that instead, or throws {@link CandidateRebaseConflict}.
     */
    async publish(
      input: WorkCommand,
      candidate: { bundle: Buffer; sha: string; branch: string; rebase?: boolean },
      signal?: AbortSignal,
      /** The WIP commit this run last published there, which the push may replace. */
      lease?: string,
    ): Promise<string> {
      const command = parse(input);
      if (
        !/^[a-f0-9]{40}$/.test(candidate.sha) ||
        candidate.bundle.length === 0 ||
        candidate.bundle.length > 536_870_912 ||
        !/^paws\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(candidate.branch)
      )
        throw new Error("Invalid runner candidate");
      if (lease !== undefined && !/^[a-f0-9]{40}$/.test(lease))
        throw new Error("Invalid runner candidate lease");
      if (command.type !== "run") throw new Error("Only a run can publish a candidate");
      await invoke(["check-ref-format", `refs/heads/${candidate.branch}`], signal);
      return serialize(command, async (mirror) => {
        signal?.throwIfAborted();
        const path = join(options.root, `candidate-${randomUUID()}.bundle`);
        writeFileSync(path, candidate.bundle, { mode: 0o600, flag: "wx" });
        try {
          await invoke(["--git-dir", mirror, "bundle", "verify", path], signal);
          // A candidate bundle holds HEAD; a checkpoint bundle holds the one ref it was made from.
          const heads = (await invoke(["--git-dir", mirror, "bundle", "list-heads", path], signal))
            .trim()
            .split("\n")
            .filter(Boolean);
          const head = heads.length === 1 ? heads[0]!.split(" ")[1] : undefined;
          if (!head || !/^(HEAD|refs\/paws\/checkpoint-[a-f0-9-]{36})$/.test(head))
            throw new Error("Runner candidate bundle must hold one head");
          await invoke(["--git-dir", mirror, "fetch", "--no-tags", path, head], signal);
          const sha = (
            await invoke(["--git-dir", mirror, "rev-parse", "FETCH_HEAD"], signal)
          ).trim();
          if (sha !== candidate.sha)
            throw new Error("Runner candidate commit does not match its bundle");
          const bases = await candidateBases(
            (args) => invoke(["--git-dir", mirror, ...args], signal),
            command.repository.baseSha,
          );
          if (command.repository.mainSha) bases.push(command.repository.mainSha);
          const excluded = bases.map((base) => `^${base}`);
          await assertDescendsFromAny(
            (args) => invoke(["--git-dir", mirror, ...args], signal),
            bases,
            sha,
          );
          const rebased = await invoke(
            ["--git-dir", mirror, "merge-base", "--is-ancestor", command.repository.baseSha, sha],
            signal,
          ).then(
            () => false,
            (caughtError1) => {
              journalCaught(caughtError1, "runner-repositories.publish.invoke", null);
              return true;
            },
          );
          if (command.commitPolicy) {
            const commits = (
              await invoke(
                ["--git-dir", mirror, "--no-replace-objects", "rev-list", sha, ...excluded],
                signal,
              )
            )
              .trim()
              .split("\n")
              .filter(Boolean);
            for (const commit of commits) {
              const metadata = (
                await invoke(
                  [
                    "--git-dir",
                    mirror,
                    "--no-replace-objects",
                    "show",
                    "-s",
                    "--format=%an%n%ae%n%cn%n%ce",
                    commit,
                  ],
                  signal,
                )
              )
                .trimEnd()
                .split("\n");
              const message = await invoke(
                ["--git-dir", mirror, "--no-replace-objects", "show", "-s", "--format=%B", commit],
                signal,
              );
              validateCommitAttribution(
                command.commitPolicy,
                metadata,
                commitCoauthorTrailers(message),
              );
            }
          }
          if (command.inputFiles?.length) {
            const changed = (
              await invoke(
                [
                  "--git-dir",
                  mirror,
                  "log",
                  "--format=",
                  "--name-only",
                  "-z",
                  "-m",
                  "--no-renames",
                  sha,
                  ...excluded,
                  "--",
                ],
                signal,
              )
            ).split("\0");
            if (
              changed.some((changedPath) =>
                command.inputFiles!.some(
                  (file) =>
                    changedPath === file.path ||
                    changedPath.startsWith(`${file.path}/`) ||
                    file.path.startsWith(`${changedPath}/`),
                ),
              )
            )
              throw new Error("Private runner input cannot enter candidate history");
          }
          const ref = `refs/heads/paws-candidate-${randomUUID()}`;
          try {
            await invoke(["--git-dir", mirror, "update-ref", ref, sha]);
            signal?.throwIfAborted();
            const token = await options.credential(command, "write");
            signal?.throwIfAborted();
            const push = (target: string, expected?: string) =>
              network({
                operation: "push",
                remoteUrl: command.repository.remoteUrl,
                token,
                cwd: mirror,
                refspec: `${target}:refs/heads/${candidate.branch}`,
                ...(expected ? { lease: expected } : {}),
                env,
                signal,
              });
            try {
              if (lease && lease !== sha) await push(sha, lease);
              else if (!rebased) await push(sha);
              else
                await push(sha).catch((caughtError4) => {
                  journalCaught(caughtError4, "runner-repositories.publish.push", null);
                  return push(sha, command.repository.baseSha);
                });
              return sha;
            } catch (error) {
              if (!branchMoved(error)) throw error;
              journalCaught(error, "runner-repositories.publish.branchMoved", null);
              // The branch moved on GitHub while the turn ran (PAS-886): the turn's own commits go
              // on top of the branch as it is now, with a lease on that tip, and no new turn.
              let rejection: unknown = error;
              for (let attempt = 0; attempt < CANDIDATE_REBASE_TRIES; attempt++) {
                await network({
                  operation: "fetch",
                  remoteUrl: command.repository.remoteUrl,
                  token,
                  cwd: options.root,
                  dest: mirror,
                  env,
                  signal,
                });
                signal?.throwIfAborted();
                const tip = (
                  await invoke(
                    [
                      "--git-dir",
                      mirror,
                      "rev-parse",
                      "--verify",
                      "--quiet",
                      `refs/heads/${candidate.branch}^{commit}`,
                    ],
                    signal,
                  ).catch((caughtError5) => {
                    journalCaught(caughtError5, "runner-repositories.publish.tip", null);
                    return "";
                  })
                ).trim();
                // Paws takes a candidate only on its assigned base or main, so the tip needs one.
                if (
                  !tip ||
                  !(await assertDescendsFromAny(
                    (args) => invoke(["--git-dir", mirror, ...args], signal),
                    [
                      command.repository.baseSha,
                      ...(command.repository.mainSha ? [command.repository.mainSha] : []),
                    ],
                    tip,
                  ).then(
                    () => true,
                    (caughtError6) => {
                      journalCaught(caughtError6, "runner-repositories.publish.tipBase", null);
                      return false;
                    },
                  ))
                )
                  throw rejection;
                const localGit = (args: string[]) => invoke(["--git-dir", mirror, ...args], signal);
                const tree = (await localGit(["rev-parse", `${sha}^{tree}`])).trim();
                if (
                  tree === (await localGit(["rev-parse", `${tip}^{tree}`])).trim() &&
                  (await localGit(["merge-base", "--is-ancestor", sha, tip]).then(
                    () => true,
                    () => false,
                  ))
                )
                  return tip;
                const remoteMerges = (
                  await localGit(["rev-list", "--merges", `${sha}..${tip}`])
                ).trim();
                const patches = (await localGit(["cherry", sha, tip]))
                  .trim()
                  .split("\n")
                  .filter(Boolean);
                if (!remoteMerges && patches.every((line) => /^- [a-f0-9]{40}$/.test(line))) {
                  const metadata = (
                    await localGit(["show", "-s", "--format=%an%n%ae%n%cn%n%ce%n%B", sha])
                  ).split("\n");
                  const [author, authorEmail, committer, committerEmail, ...message] = metadata;
                  const credits = commitCoauthorTrailers(message.join("\n"));
                  const merged = await spawnGit(
                    ["--git-dir", mirror, "commit-tree", tree, "-p", sha, "-p", tip, "-F", "-"],
                    {
                      stdin: `Merge patch-equivalent item history\n\n${credits.map((credit) => `Co-authored-by: ${credit}`).join("\n")}\n`,
                      env: {
                        GIT_AUTHOR_NAME: author!,
                        GIT_AUTHOR_EMAIL: authorEmail!,
                        GIT_COMMITTER_NAME: committer!,
                        GIT_COMMITTER_EMAIL: committerEmail!,
                      },
                      signal,
                    },
                  );
                  if (merged.code !== 0)
                    throw new Error(`Candidate history merge failed: ${merged.stderr}`, {
                      cause: error,
                    });
                  const joined = merged.stdout.trim();
                  await localGit(["update-ref", ref, joined]);
                  try {
                    await push(joined, tip);
                    return joined;
                  } catch (retryError) {
                    if (!branchMoved(retryError)) throw retryError;
                    rejection = retryError;
                    continue;
                  }
                }
                if (!candidate.rebase) throw rejection;
                const replayed = await replay(mirror, sha, [...excluded, `^${tip}`], tip, signal);
                if (replayed === tip) return tip;
                await invoke(["--git-dir", mirror, "update-ref", ref, replayed]);
                try {
                  await push(replayed, tip);
                  return replayed;
                } catch (retryError) {
                  if (!branchMoved(retryError)) throw retryError;
                  journalCaught(retryError, "runner-repositories.publish.branchMoved", null);
                  rejection = retryError;
                }
              }
              throw rejection;
            }
          } finally {
            await invoke(["--git-dir", mirror, "update-ref", "-d", ref]);
          }
        } finally {
          rmSync(path, { force: true });
        }
      });
    },
  };
}
export type RunnerRepositories = ReturnType<typeof createRunnerRepositories>;

/** How often a candidate push refused because the branch moved is rebased and tried again. */
const CANDIDATE_REBASE_TRIES = 3;

/** GitHub refused a push because the branch is not where the push expected it (PAS-886). */
function branchMoved(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /! \[rejected\][^\n]*\((stale info|non-fast-forward|fetch first)\)/.test(message);
}

/** The candidate's own commits conflict with the branch as it is on GitHub now. */
export class CandidateRebaseConflict extends Error {
  readonly files: string[];
  constructor(files: string[]) {
    super("The candidate conflicts with the branch on GitHub");
    this.name = "CandidateRebaseConflict";
    this.files = files;
  }
}
