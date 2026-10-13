import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  rmSync,
  statSync,
  lstatSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { defaultGitExec, runGitHubGit } from "../github";
import { RunnerCommandSchema, type RunnerCommand } from "../runner-protocol";

type WorkCommand = Extract<RunnerCommand, { type: "run" | "review" | "check" }>;
type NetworkOperation = {
  operation: "clone" | "fetch" | "push";
  remoteUrl: string;
  token: string;
  cwd: string;
  dest?: string;
  refspec?: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

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
  const queues = new Map<string, Promise<unknown>>();
  function serialize<T>(
    command: WorkCommand,
    operation: (mirror: string) => Promise<T>,
  ): Promise<T> {
    const repository = `${command.repository.owner}/${command.repository.repo}`;
    const key = createHash("sha256").update(repository.toLowerCase()).digest("hex");
    const previous = queues.get(key) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(() => operation(join(options.root, `${key}.git`)));
    queues.set(key, pending);
    void pending
      .finally(() => {
        if (queues.get(key) === pending) queues.delete(key);
      })
      .catch(() => undefined);
    return pending;
  }
  function parse(input: WorkCommand): WorkCommand {
    const command = RunnerCommandSchema.parse(input);
    if (command.type !== "run" && command.type !== "review" && command.type !== "check")
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
          } catch {
            signal?.throwIfAborted();
          }
          if (!exists) rmSync(mirror, { recursive: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
        const snapshot = join(
          options.root,
          `snapshot-${createHash("sha256").update(command.id).digest("hex")}.bundle`,
        );
        const ref = `refs/heads/paws-snapshot-${createHash("sha256").update(command.id).digest("hex")}`;
        try {
          await invoke(["--git-dir", mirror, "update-ref", ref, base]);
          try {
            signal?.throwIfAborted();
            await invoke(["--git-dir", mirror, "bundle", "create", snapshot, ref], signal);
            chmodSync(snapshot, 0o600);
            if (statSync(snapshot).size > 536_870_912)
              throw new Error("Runner snapshot exceeds size limit");
            signal?.throwIfAborted();
          } finally {
            await invoke(["--git-dir", mirror, "update-ref", "-d", ref]);
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
    ): Promise<void> {
      const command = parse(input);
      if (
        !/^[a-f0-9]{40}$/.test(candidate.sha) ||
        candidate.bundle.length === 0 ||
        candidate.bundle.length > 536_870_912 ||
        !/^paws\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(candidate.branch)
      )
        throw new Error("Invalid runner candidate");
      if (command.type !== "run") throw new Error("Only a run can publish a candidate");
      await invoke(["check-ref-format", `refs/heads/${candidate.branch}`], signal);
      return serialize(command, async (mirror) => {
        signal?.throwIfAborted();
        const path = join(options.root, `candidate-${randomUUID()}.bundle`);
        writeFileSync(path, candidate.bundle, { mode: 0o600, flag: "wx" });
        try {
          await invoke(["--git-dir", mirror, "bundle", "verify", path], signal);
          await invoke(["--git-dir", mirror, "fetch", "--no-tags", path, "HEAD"], signal);
          const sha = (
            await invoke(["--git-dir", mirror, "rev-parse", "FETCH_HEAD"], signal)
          ).trim();
          if (sha !== candidate.sha)
            throw new Error("Runner candidate commit does not match its bundle");
          await invoke(
            ["--git-dir", mirror, "merge-base", "--is-ancestor", command.repository.baseSha, sha],
            signal,
          );
          const ref = `refs/heads/paws-candidate-${randomUUID()}`;
          try {
            await invoke(["--git-dir", mirror, "update-ref", ref, sha]);
            signal?.throwIfAborted();
            const token = await options.credential(command, "write");
            signal?.throwIfAborted();
            await network({
              operation: "push",
              remoteUrl: command.repository.remoteUrl,
              token,
              cwd: mirror,
              refspec: `${sha}:refs/heads/${candidate.branch}`,
              env,
              signal,
            });
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
