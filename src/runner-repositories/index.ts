import { journalCaught } from "../journal";
import { assertDescendsFromAny, commitCoauthorTrailers, validateCommitAttribution } from "../core";
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
import { conflictBranchName, defaultGitExec, runGitHubGit } from "../github";
import { RunnerCommandSchema, runnerCandidateBases, type RunnerCommand } from "../runner-protocol";

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
  const invoke = async (
    args: string[],
    signal?: AbortSignal,
    extra: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
  ) =>
    (
      await execute(
        ["-c", "core.hooksPath=/dev/null", "-c", "transfer.fsckObjects=true", ...args],
        {
          cwd: extra.cwd ?? options.root,
          env: { ...env, ...extra.env },
          signal,
        },
      )
    ).stdout;
  const ancestor = (mirror: string, older: string, newer: string, signal?: AbortSignal) =>
    invoke(["--git-dir", mirror, "merge-base", "--is-ancestor", older, newer], signal).then(
      () => true,
      () => false,
    );
  /** Checks each commit of `sha` outside `excluded` against the run's commit policy. */
  async function validateCommits(
    command: Extract<WorkCommand, { type: "run" }>,
    mirror: string,
    sha: string,
    excluded: string[],
    signal?: AbortSignal,
  ) {
    if (!command.commitPolicy) return;
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
      validateCommitAttribution(command.commitPolicy, metadata, commitCoauthorTrailers(message));
    }
  }
  /**
   * Replays the candidate's own commits onto the branch tip in a scratch worktree, keeping each
   * author and the candidate's committer. Returns the new head, or the conflicting files.
   */
  async function rebaseOnto(
    mirror: string,
    sha: string,
    tip: string,
    signal?: AbortSignal,
  ): Promise<{ sha: string } | { files: string[] }> {
    const [committer, email] = (
      await invoke(["--git-dir", mirror, "show", "-s", "--format=%cn%n%ce", sha], signal)
    )
      .trimEnd()
      .split("\n");
    const scratch = join(options.root, `rebase-${randomUUID()}`);
    await invoke(["--git-dir", mirror, "worktree", "add", "--detach", scratch, sha], signal);
    try {
      const identity = {
        env: { GIT_COMMITTER_NAME: committer ?? "", GIT_COMMITTER_EMAIL: email ?? "" },
        cwd: scratch,
      };
      try {
        await invoke(
          ["-c", "commit.gpgsign=false", "rebase", "--no-autosquash", tip],
          signal,
          identity,
        );
      } catch (error) {
        signal?.throwIfAborted();
        journalCaught(error, "runner-repositories.rebaseOnto", null, "the rebase conflicted");
        const files = (
          await invoke(["diff", "--name-only", "--diff-filter=U", "-z"], signal, identity)
        )
          .split("\0")
          .filter(Boolean)
          .slice(0, 64);
        await invoke(["rebase", "--abort"], undefined, identity).catch((caughtError) =>
          journalCaught(caughtError, "runner-repositories.rebaseOnto.abort", null),
        );
        return { files };
      }
      return { sha: (await invoke(["rev-parse", "HEAD"], signal, identity)).trim() };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      await invoke(["--git-dir", mirror, "worktree", "prune"]).catch((caughtError) =>
        journalCaught(caughtError, "runner-repositories.rebaseOnto.prune", null),
      );
    }
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
        const branchTip = command.repository.branchSha;
        if (
          branchTip &&
          (
            await invoke(
              ["--git-dir", mirror, "rev-parse", "--verify", `${branchTip}^{commit}`],
              signal,
            )
          ).trim() !== branchTip
        )
          throw new Error("Assigned branch tip is unavailable");
        const snapshot = join(
          options.root,
          `snapshot-${createHash("sha256").update(command.id).digest("hex")}.bundle`,
        );
        const ref = `refs/heads/paws-snapshot-${createHash("sha256").update(command.id).digest("hex")}`;
        try {
          const mainRef = `${ref}-main`;
          const branchRef = `${ref}-branch`;
          await invoke(["--git-dir", mirror, "update-ref", ref, base]);
          try {
            if (main) await invoke(["--git-dir", mirror, "update-ref", mainRef, main]);
            if (branchTip) await invoke(["--git-dir", mirror, "update-ref", branchRef, branchTip]);
            signal?.throwIfAborted();
            await invoke(
              [
                "--git-dir",
                mirror,
                "bundle",
                "create",
                snapshot,
                ref,
                ...(main ? [mainRef] : []),
                ...(branchTip ? [branchRef] : []),
              ],
              signal,
            );
            chmodSync(snapshot, 0o600);
            if (statSync(snapshot).size > 536_870_912)
              throw new Error("Runner snapshot exceeds size limit");
            signal?.throwIfAborted();
          } finally {
            await invoke(["--git-dir", mirror, "update-ref", "-d", ref]);
            if (main) await invoke(["--git-dir", mirror, "update-ref", "-d", mainRef]);
            if (branchTip) await invoke(["--git-dir", mirror, "update-ref", "-d", branchRef]);
          }
          signal?.throwIfAborted();
          return { mirror, bundle: snapshot };
        } catch (error) {
          rmSync(snapshot, { force: true });
          throw error;
        }
      });
    },
    async publish(
      input: WorkCommand,
      candidate: { bundle: Buffer; sha: string; branch: string },
      signal?: AbortSignal,
      /** The WIP commit this run last published there, which the push may replace. */
      lease?: string,
      /** A candidate rebases onto commits the branch gained; a WIP checkpoint does not. */
      rebase = false,
    ): Promise<CandidatePublication> {
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
          const bases = runnerCandidateBases(command.repository);
          const excluded = bases.map((base) => `^${base}`);
          const descends = (commit: string) =>
            assertDescendsFromAny(
              (args) => invoke(["--git-dir", mirror, ...args], signal),
              bases,
              commit,
            );
          await descends(sha);
          await validateCommits(command, mirror, sha, excluded, signal);
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
          // The branch as GitHub holds it now; every push leases on it, so a push never
          // replaces commits it did not see. The fetch prunes, so it comes before the push ref.
          await network({
            operation: "fetch",
            remoteUrl: command.repository.remoteUrl,
            token: await options.credential(command, "read"),
            cwd: options.root,
            dest: mirror,
            env,
            signal,
          });
          signal?.throwIfAborted();
          const ref = `refs/heads/paws-candidate-${randomUUID()}`;
          try {
            await invoke(["--git-dir", mirror, "update-ref", ref, sha]);
            signal?.throwIfAborted();
            const token = await options.credential(command, "write");
            signal?.throwIfAborted();
            const push = (commit: string, branch: string, expected: string | null) =>
              network({
                operation: "push",
                remoteUrl: command.repository.remoteUrl,
                token,
                cwd: mirror,
                refspec: `${commit}:refs/heads/${branch}`,
                ...(expected ? { lease: expected } : {}),
                env,
                signal,
              });
            const remoteSha = async (branch: string) =>
              (
                await invoke(
                  [
                    "--git-dir",
                    mirror,
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    `refs/heads/${branch}^{commit}`,
                  ],
                  signal,
                ).catch(() => "")
              ).trim() || null;
            const tip = await remoteSha(candidate.branch);
            /**
             * A conflict round's head, or one that contains the parked candidate, supersedes the
             * conflict branch. Its deletion is best effort; Paws deletes it again when the item ends.
             */
            const retire = async (pushed: string) => {
              const side = conflictBranchName(candidate.branch);
              const parked = await remoteSha(side);
              if (
                !parked ||
                (!command.repository.branchSha && !(await ancestor(mirror, parked, pushed, signal)))
              )
                return;
              await network({
                operation: "push",
                remoteUrl: command.repository.remoteUrl,
                token,
                cwd: mirror,
                refspec: `:refs/heads/${side}`,
                lease: parked,
                env,
                signal,
              }).catch((error: unknown) =>
                journalCaught(error, "runner-repositories.publish.retire", command.itemId),
              );
            };
            if (tip === sha) {
              if (rebase) await retire(sha);
              return { sha };
            }
            // The tip is in the candidate, is this run's own WIP commit the candidate replaces,
            // or is a head this run started from and then rebased away from on purpose.
            if (
              tip === null ||
              tip === lease ||
              (await ancestor(mirror, tip, sha, signal)) ||
              (!(await ancestor(mirror, command.repository.baseSha, sha, signal)) &&
                (await ancestor(mirror, tip, command.repository.baseSha, signal)))
            ) {
              await push(sha, candidate.branch, tip);
              if (rebase) await retire(sha);
              return { sha };
            }
            if (!rebase)
              throw new Error(
                `${candidate.branch} on GitHub is at ${tip.slice(0, 7)}, which this commit does not contain`,
              );
            await descends(tip).catch((error: unknown) => {
              throw new Error(
                `${candidate.branch} on GitHub is at ${tip.slice(0, 7)}, which descends from neither the run's base nor main`,
                { cause: error },
              );
            });
            const rebased = await rebaseOnto(mirror, sha, tip, signal);
            if ("sha" in rebased) {
              await validateCommits(command, mirror, rebased.sha, [`^${tip}`], signal);
              await invoke(["--git-dir", mirror, "update-ref", ref, rebased.sha]);
              if (rebased.sha !== tip) await push(rebased.sha, candidate.branch, tip);
              await retire(rebased.sha);
              return { sha: rebased.sha, rebasedFrom: sha };
            }
            // The candidate waits on its own branch, so the conflict round keeps its commits.
            const side = conflictBranchName(candidate.branch);
            const parked = await remoteSha(side);
            if (parked !== sha) await push(sha, side, parked);
            return { conflict: { branch: side, sha, tip, files: rebased.files } };
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

/**
 * What reached the item's branch: the candidate, the candidate rebased onto commits the branch
 * gained, or nothing, when that rebase conflicted and the candidate waits on its side branch.
 */
export type CandidatePublication =
  | { sha: string; rebasedFrom?: string }
  | { conflict: { branch: string; sha: string; tip: string; files: string[] } };
