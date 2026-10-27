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

/** The branch on GitHub holds commits the candidate lacks, and they cannot be combined cleanly. */
export class RunnerCandidateConflict extends Error {
  constructor(
    readonly branch: string,
    readonly remote: string,
    detail: string,
  ) {
    super(`Paws could not rebase the candidate onto ${branch}: ${detail}`);
    this.name = "RunnerCandidateConflict";
  }
}

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
  /**
   * Replays the candidate's own commits onto the branch tip on GitHub, keeping each commit's
   * author, committer and message. A commit that is already there replays to nothing and is
   * dropped. Throws {@link RunnerCandidateConflict} when a commit does not apply cleanly.
   */
  async function replay(
    mirror: string,
    sha: string,
    onto: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const git = (args: string[]) =>
      invoke(["--git-dir", mirror, "--no-replace-objects", ...args], signal);
    if ((await git(["rev-list", "--min-parents=2", sha, `^${onto}`])).trim())
      throw new RunnerCandidateConflict(
        branch,
        onto,
        "the candidate holds a merge commit, which Paws does not replay",
      );
    const commits = (await git(["rev-list", "--reverse", "--topo-order", sha, `^${onto}`]))
      .trim()
      .split("\n")
      .filter(Boolean);
    let head = onto;
    for (const commit of commits) {
      const tree = await git([
        "merge-tree",
        "--write-tree",
        "--no-messages",
        `--merge-base=${commit}^`,
        head,
        commit,
      ]).then(
        (output) => output.split("\n")[0]!.trim(),
        (error) => {
          journalCaught(error, "runner-repositories.replay.merge-tree", null);
          throw new RunnerCandidateConflict(
            branch,
            onto,
            `commit ${commit.slice(0, 7)} conflicts with the branch on GitHub at ${onto.slice(0, 7)}`,
          );
        },
      );
      if (tree === (await git(["rev-parse", `${head}^{tree}`])).trim()) continue;
      const [authorName, authorEmail, authorDate, committerName, committerEmail, committerDate] = (
        await git(["show", "-s", "--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI", commit])
      )
        .replace(/\n$/, "")
        .split("\0");
      const message = join(options.root, `replay-${randomUUID()}.txt`);
      writeFileSync(message, await git(["show", "-s", "--format=%B", commit]), {
        mode: 0o600,
        flag: "wx",
      });
      try {
        head = (
          await execute(
            [
              "-c",
              "core.hooksPath=/dev/null",
              "--git-dir",
              mirror,
              "commit-tree",
              tree,
              "-p",
              head,
              "-F",
              message,
            ],
            {
              cwd: options.root,
              env: {
                ...env,
                GIT_AUTHOR_NAME: authorName,
                GIT_AUTHOR_EMAIL: authorEmail,
                GIT_AUTHOR_DATE: authorDate,
                GIT_COMMITTER_NAME: committerName,
                GIT_COMMITTER_EMAIL: committerEmail,
                GIT_COMMITTER_DATE: committerDate,
              },
              signal,
            },
          )
        ).stdout.trim();
      } finally {
        rmSync(message, { force: true });
      }
    }
    return head;
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
    async publish(
      input: WorkCommand,
      candidate: { bundle: Buffer; sha: string; branch: string },
      signal?: AbortSignal,
      /** The WIP commit this run last published there, which the push may replace. */
      lease?: string,
    ): Promise<{ sha: string }> {
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
          const bases = [command.repository.baseSha];
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
          // An earlier turn of this item may have pushed work the candidate does not hold.
          const branchRef = `refs/heads/${candidate.branch}`;
          await invoke(["--git-dir", mirror, "update-ref", "-d", branchRef], signal);
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
          const remote = await invoke(
            ["--git-dir", mirror, "rev-parse", "--verify", "--quiet", `${branchRef}^{commit}`],
            signal,
          ).then(
            (value) => value.trim() || undefined,
            () => undefined,
          );
          const contains = (ancestor: string, descendant: string) =>
            invoke(
              ["--git-dir", mirror, "merge-base", "--is-ancestor", ancestor, descendant],
              signal,
            ).then(
              () => true,
              () => false,
            );
          let pushed = sha;
          // Every push leases the tip it saw, so it never replaces commits it did not account for.
          // Only this run's WIP commit, or the head a rebase onto main replaced, may be dropped.
          if (
            remote !== undefined &&
            remote !== sha &&
            !(await contains(remote, sha)) &&
            remote !== lease &&
            !(rebased && remote === command.repository.baseSha)
          ) {
            if (rebased || !(await contains(command.repository.baseSha, remote)))
              throw new RunnerCandidateConflict(
                candidate.branch,
                remote,
                `the branch on GitHub moved to ${remote.slice(0, 7)}, which does not descend from the run's start ${command.repository.baseSha.slice(0, 7)}`,
              );
            pushed = await replay(mirror, sha, remote, candidate.branch, signal);
          }
          if (pushed === remote) return { sha: pushed };
          const ref = `refs/heads/paws-candidate-${randomUUID()}`;
          try {
            await invoke(["--git-dir", mirror, "update-ref", ref, pushed]);
            signal?.throwIfAborted();
            const token = await options.credential(command, "write");
            signal?.throwIfAborted();
            await network({
              operation: "push",
              remoteUrl: command.repository.remoteUrl,
              token,
              cwd: mirror,
              refspec: `${pushed}:${branchRef}`,
              ...(remote ? { lease: remote } : {}),
              env,
              signal,
            });
          } finally {
            await invoke(["--git-dir", mirror, "update-ref", "-d", ref]);
          }
          return { sha: pushed };
        } finally {
          rmSync(path, { force: true });
        }
      });
    },
  };
}
export type RunnerRepositories = ReturnType<typeof createRunnerRepositories>;
