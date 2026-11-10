import { journalCaught } from "../journal";
import {
  appBotCommitIdentity,
  assertDescendsFromAny,
  candidateBases,
  checkpointRef,
  checkpointStart,
  commitCoauthorTrailers,
  commitIdentityEnv,
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
import {
  RunnerCommandSchema,
  type RunnerCommand,
  type RunnerRepositoryCommand,
  type RunnerRepositoryCommandResult,
} from "../runner-protocol";

type WorkCommand = Extract<RunnerCommand, { type: "run" | "review" }>;
type NetworkOperation = {
  operation: "clone" | "fetch" | "push";
  remoteUrl: string;
  token: string;
  cwd: string;
  dest?: string;
  refspec?: string;
  lease?: string;
  filter?: string;
  objects?: string[];
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

const queues = new Map<string, Promise<unknown>>();

export function createRunnerRepositories(options: {
  root: string;
  home: string;
  credential(command: WorkCommand, access: "read" | "write"): Promise<string>;
  networkGit?: (input: NetworkOperation) => Promise<void>;
  snapshotFilter?: string;
  agentHome?: string;
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
  const localEnv = { ...env, GIT_NO_LAZY_FETCH: "1" };
  const repositoryRoot = realpathSync(options.root);
  function serialize<T>(
    command: { repository: { owner: string; repo: string } },
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
          env: localEnv,
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
      env: { ...localEnv, ...input.env },
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
  async function firstParentCommits(
    mirror: string,
    head: string,
    excluded: string[],
    signal?: AbortSignal,
  ): Promise<string[]> {
    return (
      await invoke(
        ["--git-dir", mirror, "rev-list", "--reverse", "--first-parent", head, ...excluded],
        signal,
      )
    )
      .trim()
      .split("\n")
      .filter(Boolean);
  }
  async function readCommit(mirror: string, commit: string, signal?: AbortSignal) {
    const raw = await invoke(["--git-dir", mirror, "cat-file", "commit", commit], signal);
    const split = raw.indexOf("\n\n");
    const headers = (split === -1 ? raw : raw.slice(0, split)).split("\n");
    const person = (role: "author" | "committer") => {
      const line = headers.find((header) => header.startsWith(`${role} `));
      const match = line && /^\S+ (.*) <([^>]*)> (\d+ [+-]\d{4})$/.exec(line);
      if (!match) throw new Error(`Runner candidate commit ${commit} has no ${role}`);
      return { name: match[1]!, email: match[2]!, date: match[3]! };
    };
    return {
      author: person("author"),
      committer: person("committer"),
      message: split === -1 ? "" : raw.slice(split + 2),
    };
  }
  async function mergedTree(
    mirror: string,
    base: string,
    onto: string,
    head: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const merged = await spawnGit(
      [
        "--git-dir",
        mirror,
        "merge-tree",
        "--write-tree",
        "--name-only",
        "--no-messages",
        "-z",
        `--merge-base=${base}`,
        onto,
        head,
      ],
      { signal },
    );
    const [tree, ...files] = merged.stdout.split("\0").filter(Boolean);
    if (merged.code === 1) throw new CandidateRebaseConflict(files);
    if (merged.code !== 0 || !tree || !/^[a-f0-9]{40}$/.test(tree))
      throw new Error(`Runner candidate rebase failed: ${merged.stderr.trim()}`);
    return tree;
  }
  async function sameTree(mirror: string, tree: string, commit: string) {
    return tree === (await invoke(["--git-dir", mirror, "rev-parse", `${commit}^{tree}`])).trim();
  }
  async function writeCommit(
    mirror: string,
    commit: {
      tree: string;
      parent: string;
      message: string;
      author: { name: string; email: string; date: string };
      committer: { name: string; email: string; date?: string };
    },
    signal?: AbortSignal,
  ): Promise<string> {
    const { author, committer } = commit;
    const created = await spawnGit(
      ["--git-dir", mirror, "commit-tree", commit.tree, "-p", commit.parent, "-F", "-"],
      {
        stdin: commit.message,
        env: {
          GIT_AUTHOR_NAME: author.name,
          GIT_AUTHOR_EMAIL: author.email,
          GIT_AUTHOR_DATE: author.date,
          GIT_COMMITTER_NAME: committer.name,
          GIT_COMMITTER_EMAIL: committer.email,
          ...(committer.date ? { GIT_COMMITTER_DATE: committer.date } : {}),
        },
        signal,
      },
    );
    const sha = created.stdout.trim();
    if (created.code !== 0 || !/^[a-f0-9]{40}$/.test(sha))
      throw new Error(`Runner candidate rebase failed: ${created.stderr.trim()}`);
    return sha;
  }
  async function squash(
    mirror: string,
    commits: string[],
    range: { base: string; onto: string; head: string; title?: string },
    committer: { name: string; email: string } | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    const tree = await mergedTree(mirror, range.base, range.onto, range.head, signal);
    if (await sameTree(mirror, tree, range.onto)) return range.onto;
    const originals = await Promise.all(commits.map((sha) => readCommit(mirror, sha, signal)));
    const subjects = originals.map((commit) => commit.message.split("\n", 1)[0]!.trim());
    const trailers = new Set(originals.flatMap((commit) => commitCoauthorTrailers(commit.message)));
    return writeCommit(
      mirror,
      {
        tree,
        parent: range.onto,
        message: `${[
          range.title ?? subjects[0]!,
          subjects.join("\n"),
          [...trailers].map((trailer) => `Co-authored-by: ${trailer}`).join("\n"),
        ]
          .filter(Boolean)
          .join("\n\n")}\n`,
        author: originals[0]!.author,
        committer: committer ?? originals.at(-1)!.committer,
      },
      signal,
    );
  }
  async function replay(
    mirror: string,
    head: string,
    excluded: string[],
    onto: string,
    title: string | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    const commits = await firstParentCommits(mirror, head, excluded, signal);
    const [commit] = commits;
    if (!commit) return onto;
    const base = `${commit}^`;
    if (commits.length > 1)
      return squash(mirror, commits, { base, onto, head, title }, undefined, signal);
    const tree = await mergedTree(mirror, base, onto, commit, signal);
    if (await sameTree(mirror, tree, onto)) return onto;
    return writeCommit(
      mirror,
      { tree, parent: onto, ...(await readCommit(mirror, commit, signal)) },
      signal,
    );
  }
  async function sync(mirror: string, remoteUrl: string, token: string, signal?: AbortSignal) {
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
        journalCaught(caughtError3, "runner-repositories.sync.trim", null);
      }
      if (!exists) rmSync(mirror, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      journalCaught(
        error,
        "runner-repositories.sync.lstatSync",
        null,
        "optional file may be absent",
      );
    }
    const destination = exists ? mirror : join(options.root, `clone-${randomUUID()}.git`);
    try {
      await network({
        operation: exists ? "fetch" : "clone",
        remoteUrl,
        token,
        cwd: options.root,
        dest: destination,
        ...(exists ? {} : { filter: "blob:none" }),
        env,
        signal,
      });
      signal?.throwIfAborted();
      if (!exists) {
        if (
          (
            await invoke(["--git-dir", destination, "rev-parse", "--is-bare-repository"], signal)
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
  }
  async function prefetch(
    mirror: string,
    tips: string[],
    fetch: (objects: string[]) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const missing = new Set<string>();
    for (const tip of tips) {
      const listed = await spawnGit(
        [
          "--git-dir",
          mirror,
          "rev-list",
          "--objects",
          "--no-object-names",
          "--missing=print",
          `--max-count=${SNAPSHOT_BLOB_COMMITS}`,
          tip,
        ],
        { signal },
      );
      if (listed.code !== 0)
        throw new Error(`Runner prefetch list failed: ${listed.stderr.trim()}`);
      for (const line of listed.stdout.split("\n"))
        if (line.startsWith("?")) missing.add(line.slice(1));
    }
    const objects = [...missing];
    for (let start = 0; start < objects.length; start += PREFETCH_BATCH) {
      await fetch(objects.slice(start, start + PREFETCH_BATCH));
      signal?.throwIfAborted();
    }
  }
  async function filteredSnapshot(
    mirror: string,
    bundle: string,
    blobs: string,
    refs: string[],
    tips: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    await invoke(
      [
        "--git-dir",
        mirror,
        "bundle",
        "create",
        bundle,
        `--filter=${options.snapshotFilter ?? "blob:none"}`,
        ...refs,
      ],
      signal,
    );
    chmodSync(bundle, 0o600);
    if (statSync(bundle).size > 536_870_912) throw new Error("Runner snapshot exceeds size limit");
    const objects = new Set<string>();
    for (const tip of tips)
      for (const object of (
        await invoke(
          [
            "--git-dir",
            mirror,
            "rev-list",
            "--objects",
            "--no-object-names",
            `--max-count=${SNAPSHOT_BLOB_COMMITS}`,
            tip,
          ],
          signal,
        )
      ).split("\n"))
        if (object) objects.add(object);
    const typed = await spawnGit(
      ["--git-dir", mirror, "cat-file", "--batch-check=%(objecttype) %(objectname)"],
      { stdin: `${[...objects].join("\n")}\n`, signal },
    );
    if (typed.code !== 0) throw new Error(`Runner snapshot blob list failed: ${typed.stderr}`);
    const list = typed.stdout
      .split("\n")
      .filter((line) => line.startsWith("blob "))
      .map((line) => line.slice(5));
    const prefix = join(options.root, `blobs-${randomUUID()}`);
    const packed = await spawnGit(["--git-dir", mirror, "pack-objects", "-q", prefix], {
      stdin: list.length ? `${list.join("\n")}\n` : "",
      signal,
    });
    const hash = packed.stdout.trim();
    try {
      if (packed.code !== 0 || !/^[a-f0-9]{40,64}$/.test(hash))
        throw new Error(`Runner snapshot blob pack failed: ${packed.stderr.trim()}`);
      renameSync(`${prefix}-${hash}.pack`, blobs);
    } finally {
      for (const suffix of [".pack", ".idx", ".rev"])
        rmSync(`${prefix}-${hash}${suffix}`, { force: true });
    }
    chmodSync(blobs, 0o600);
    if (statSync(blobs).size > 536_870_912)
      throw new Error("Runner snapshot blobs exceed size limit");
  }
  return {
    async prepare(
      input: WorkCommand,
      signal?: AbortSignal,
    ): Promise<{ mirror: string; bundle: string; blobs?: string }> {
      const command = parse(input);
      return serialize(command, async (mirror) => {
        signal?.throwIfAborted();
        const token = await options.credential(command, "read");
        signal?.throwIfAborted();
        await sync(mirror, command.repository.remoteUrl, token, signal);
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
        const restore = command.type === "run" ? command.restoreCheckpoint : undefined;
        if (restore) {
          const hidden = checkpointRef(restore.branch);
          await invoke(["check-ref-format", hidden], signal);
          await network({
            operation: "fetch",
            remoteUrl: command.repository.remoteUrl,
            token,
            cwd: options.root,
            dest: mirror,
            refspec: `+${hidden}:${hidden}`,
            env,
            signal,
          });
          signal?.throwIfAborted();
          const saved = (
            await invoke(
              ["--git-dir", mirror, "rev-parse", "--verify", `${hidden}^{commit}`],
              signal,
            )
          ).trim();
          if (saved !== restore.sha) throw new Error("Assigned checkpoint is unavailable");
          await checkpointStart(
            (args) => invoke(["--git-dir", mirror, ...args], signal),
            saved,
            main ? [base, main] : [base],
          );
        }
        const snapshot = join(
          options.root,
          `snapshot-${createHash("sha256").update(command.id).digest("hex")}.bundle`,
        );
        const blobs = snapshot.replace(/\.bundle$/, ".pack");
        const ref = `refs/heads/paws-snapshot-${createHash("sha256").update(command.id).digest("hex")}`;
        const tips = [base, ...(main ? [main] : []), ...(restore ? [restore.sha] : [])];
        await prefetch(
          mirror,
          tips,
          (objects) =>
            network({
              operation: "fetch",
              remoteUrl: command.repository.remoteUrl,
              token,
              cwd: options.root,
              dest: mirror,
              objects,
              env,
              signal,
            }),
          signal,
        );
        signal?.throwIfAborted();
        try {
          const mainRef = `${ref}-main`;
          const checkpointHead = `${ref}-checkpoint`;
          const refs = [ref, ...(main ? [mainRef] : []), ...(restore ? [checkpointHead] : [])];
          await invoke(["--git-dir", mirror, "update-ref", ref, base]);
          try {
            if (main) await invoke(["--git-dir", mirror, "update-ref", mainRef, main]);
            if (restore)
              await invoke(["--git-dir", mirror, "update-ref", checkpointHead, restore.sha]);
            signal?.throwIfAborted();
            let filtered = false;
            try {
              await filteredSnapshot(mirror, snapshot, blobs, refs, tips, signal);
              filtered = true;
            } catch (error) {
              signal?.throwIfAborted();
              rmSync(snapshot, { force: true });
              rmSync(blobs, { force: true });
              journalCaught(error, "runner-repositories.prepare.filteredSnapshot", null);
              console.warn(
                JSON.stringify({
                  event: "runner_snapshot_filter_failed",
                  commandId: command.id,
                  error: error instanceof Error ? error.message : String(error),
                }),
              );
            }
            if (!filtered) {
              await invoke(["--git-dir", mirror, "bundle", "create", snapshot, ...refs], signal);
              chmodSync(snapshot, 0o600);
              if (statSync(snapshot).size > 536_870_912)
                throw new Error("Runner snapshot exceeds size limit");
            }
            signal?.throwIfAborted();
            return { mirror, bundle: snapshot, ...(filtered ? { blobs } : {}) };
          } finally {
            await invoke(["--git-dir", mirror, "update-ref", "-d", ref]);
            if (main) await invoke(["--git-dir", mirror, "update-ref", "-d", mainRef]);
            if (restore) await invoke(["--git-dir", mirror, "update-ref", "-d", checkpointHead]);
          }
        } catch (error) {
          rmSync(snapshot, { force: true });
          rmSync(blobs, { force: true });
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
      candidate: { bundle: Buffer; sha: string; branch: string; rebase?: boolean; ref?: string },
      signal?: AbortSignal,
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
      const target = candidate.ref ?? `refs/heads/${candidate.branch}`;
      const hidden = target === checkpointRef(candidate.branch);
      if (!hidden && target !== `refs/heads/${candidate.branch}`)
        throw new Error("Invalid runner candidate ref");
      if (hidden && candidate.rebase) throw new Error("A runner checkpoint is never rebased");
      await invoke(["check-ref-format", target], signal);
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
            const push = (source: string, expected?: string, force = false) =>
              network({
                operation: "push",
                remoteUrl: command.repository.remoteUrl,
                token,
                cwd: mirror,
                refspec: `${force ? "+" : ""}${source}:${target}`,
                ...(expected ? { lease: expected } : {}),
                env,
                signal,
              });
            try {
              if (hidden) await push(sha, lease, lease === undefined);
              else if (lease && lease !== sha) await push(sha, lease);
              else if (!rebased) await push(sha);
              else
                await push(sha).catch((caughtError4) => {
                  journalCaught(caughtError4, "runner-repositories.publish.push", null);
                  return push(sha, command.repository.baseSha);
                });
              return sha;
            } catch (error) {
              if (!candidate.rebase || !branchMoved(error)) throw error;
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
                const replayed = await replay(
                  mirror,
                  sha,
                  [...excluded, `^${tip}`],
                  tip,
                  command.pullRequestDraft?.title,
                  signal,
                );
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
    async rebase(
      input: RunnerRepositoryCommand,
      credential: () => Promise<string>,
      signal?: AbortSignal,
    ): Promise<RunnerRepositoryCommandResult> {
      const command = RunnerCommandSchema.parse(input);
      if (command.type !== "rebase") throw new Error("Repository rebase command is required");
      await invoke(["check-ref-format", `refs/heads/${command.branch}`], signal);
      const agentHome = options.agentHome ?? "/var/lib/paws-agent";
      if (repositoryRoot === agentHome || repositoryRoot.startsWith(`${agentHome}/`))
        throw new Error("Runner rebase worktree cannot be under the agent's home");
      return serialize(command, async (mirror) => {
        signal?.throwIfAborted();
        const token = await credential();
        signal?.throwIfAborted();
        await sync(mirror, command.repository.remoteUrl, token, signal);
        for (const [name, sha] of [
          ["head", command.head],
          ["main", command.main],
        ] as const) {
          const found = await spawnGit(
            ["--git-dir", mirror, "rev-parse", "--verify", "--quiet", `${sha}^{commit}`],
            { signal },
          );
          if (found.stdout.trim() !== sha)
            return { outcome: "failed", reason: `The ${name} commit ${sha} is not on GitHub.` };
        }
        await prefetch(
          mirror,
          [command.head, command.main],
          (objects) =>
            network({
              operation: "fetch",
              remoteUrl: command.repository.remoteUrl,
              token,
              cwd: options.root,
              dest: mirror,
              objects,
              env,
              signal,
            }),
          signal,
        );
        const worktree = join(repositoryRoot, `rebase-${randomUUID()}`);
        try {
          await invoke(
            ["--git-dir", mirror, "worktree", "add", "--quiet", "--detach", worktree, command.head],
            signal,
          );
          const { GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL } = commitIdentityEnv(
            appBotCommitIdentity(command.bot),
          );
          const commits = await firstParentCommits(
            mirror,
            command.head,
            [`^${command.main}`],
            signal,
          );
          const upToDate =
            (
              await spawnGit(
                ["--git-dir", mirror, "merge-base", "--is-ancestor", command.main, command.head],
                { signal },
              )
            ).code === 0;
          let squashed: string | null = null;
          if (commits.length > 1 && !upToDate) {
            try {
              const base = (
                await invoke(
                  ["--git-dir", mirror, "merge-base", command.main, command.head],
                  signal,
                )
              ).trim();
              squashed = await squash(
                mirror,
                commits,
                {
                  base,
                  onto: command.main,
                  head: command.head,
                  ...(command.title ? { title: command.title } : {}),
                },
                { name: GIT_COMMITTER_NAME!, email: GIT_COMMITTER_EMAIL! },
                signal,
              );
            } catch (error) {
              if (error instanceof CandidateRebaseConflict)
                return {
                  outcome: "conflict",
                  files: error.files.filter((file) => file.length <= 1024).slice(0, 1000),
                };
              signal?.throwIfAborted();
              journalCaught(error, "runner-repositories.rebase.squash", null);
              return {
                outcome: "failed",
                reason: `Rebase failed: ${error instanceof Error ? error.message : String(error)}`,
              };
            }
          }
          if (squashed === null) {
            const rebased = await spawnGit(
              [
                "-C",
                worktree,
                "-c",
                "rerere.enabled=false",
                "-c",
                "commit.gpgSign=false",
                "rebase",
                "--no-autostash",
                command.main,
              ],
              {
                env: {
                  GIT_COMMITTER_NAME: GIT_COMMITTER_NAME!,
                  GIT_COMMITTER_EMAIL: GIT_COMMITTER_EMAIL!,
                },
                signal,
              },
            );
            if (rebased.code !== 0) {
              const unmerged = await spawnGit(
                ["-C", worktree, "diff", "--name-only", "--diff-filter=U", "-z"],
                { signal },
              );
              await spawnGit(["-C", worktree, "rebase", "--abort"]);
              const files = unmerged.stdout
                .split("\0")
                .filter((file) => file && file.length <= 1024);
              if (files.length) return { outcome: "conflict", files: files.slice(0, 1000) };
              return {
                outcome: "failed",
                reason: `Rebase failed: ${rebased.stderr.trim() || `git exited ${rebased.code}`}`,
              };
            }
          }
          const head =
            squashed ?? (await invoke(["-C", worktree, "rev-parse", "HEAD"], signal)).trim();
          await invoke(["-C", worktree, "merge-base", "--is-ancestor", command.main, head], signal);
          const ref = `refs/heads/paws-candidate-${randomUUID()}`;
          await invoke(["--git-dir", mirror, "update-ref", ref, head]);
          try {
            await network({
              operation: "push",
              remoteUrl: command.repository.remoteUrl,
              token,
              cwd: mirror,
              refspec: `${head}:refs/heads/${command.branch}`,
              lease: command.head,
              env,
              signal,
            });
          } catch (error) {
            signal?.throwIfAborted();
            journalCaught(error, "runner-repositories.rebase.push", null);
            return {
              outcome: "failed",
              reason: branchMoved(error)
                ? `The branch ${command.branch} moved from ${command.head}.`
                : `Push failed: ${error instanceof Error ? error.message : String(error)}`,
            };
          } finally {
            await invoke(["--git-dir", mirror, "update-ref", "-d", ref]);
          }
          return { outcome: "rebased", head };
        } finally {
          await invoke(["--git-dir", mirror, "worktree", "remove", "--force", worktree]).catch(
            (caughtError) =>
              journalCaught(caughtError, "runner-repositories.rebase.worktreeRemove", null),
          );
          rmSync(worktree, { recursive: true, force: true });
          await invoke(["--git-dir", mirror, "worktree", "prune"]).catch((caughtError) =>
            journalCaught(caughtError, "runner-repositories.rebase.worktreePrune", null),
          );
        }
      });
    },
  };
}
export type RunnerRepositories = ReturnType<typeof createRunnerRepositories>;
export { checkpointRef };

const SNAPSHOT_BLOB_COMMITS = 200;
const PREFETCH_BATCH = 1_000;

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
