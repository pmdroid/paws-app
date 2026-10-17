import { runProviderLogin } from "../runner-login-worker";
import type { RunnerLoginUpdate } from "../runner-protocol";
import { checkoutPatterns, exclusionPatterns } from "../worktree-checkout";
import {
  closeSync,
  chmodSync,
  cpSync,
  readdirSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  lstatSync,
  openSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  appBotCommitIdentity,
  validateCandidateAttribution,
  git,
  runAgent,
  minimalAgentEnv,
  materializeImplementationSkills,
  type AcpEvent,
  type RunAgentOptions,
  type RunAgentResult,
} from "../acp";
import {
  readRunnerJob,
  readRunnerJobInputs,
  type RunnerJobInputs,
  runnerRepositoryBundlePath,
  runnerTaskRepositoryPath,
  runnerResultDirectory,
  RunnerJobSchema,
  type RunnerJob,
  type RunnerResults,
  type RunnerSpool,
} from "../runner-execution";
import { readRunnerAnswer } from "../runner-answers";
import { checkDeveloperLogin, type LoginCommandRunner } from "../install";
import {
  RunnerArtifactSchema,
  RunnerEventSchema,
  RunnerHelperResultSchema,
  type RunnerArtifact,
  type RunnerEvent,
} from "../runner-protocol";

export interface RunnerWorkerOptions {
  job: RunnerJob;
  repositoryBundle?: string;
  repositorySnapshot?: string;
  inputs?: RunnerJobInputs;
  outputDirectory: string;
  workRoot: string;
  home: string;
  resultsGid: number;
  signal?: AbortSignal;
  launch?: Pick<RunAgentOptions, "command" | "args" | "env">;
  answer?: (requestId: string, signal: AbortSignal) => Promise<{ answer: string }>;
  loginCommand?: LoginCommandRunner;
}

export type RunnerWorkerEvent =
  | { type: "login"; update: RunnerLoginUpdate }
  | { type: "acp"; event: AcpEvent }
  | { type: "question"; requestId: string; question: string; options: readonly unknown[] }
  | { type: "artifact"; requestId: string; artifact: RunnerArtifact }
  | Extract<RunnerEvent, { type: "plan" | "pull_request" }>;

export interface RunnerWorkerResult {
  executionId: string;
  commandId: string;
  run: RunAgentResult;
  candidateSha?: string;
  reviewText?: string;
  text?: string;
  login?: {
    agent: "claude" | "codex" | "grok";
    authenticated: boolean;
    method: "subscription" | "api_key" | "other" | "none";
    command: string;
  };
}

function outputFile(directory: string, name: string, resultsGid: number): number {
  const fd = openSync(
    join(directory, name),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o640,
  );
  try {
    fchownSync(fd, process.getuid!(), resultsGid);
    fchmodSync(fd, 0o640);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export async function executeRunnerCommand(
  options: RunnerWorkerOptions,
): Promise<RunnerWorkerResult> {
  const job = RunnerJobSchema.parse(options.job);
  const command = job.command;
  if (process.getuid?.() === 0) throw new Error("Runner agents must run as a non-root user");
  const repository = command.type === "run" || command.type === "review";
  const task = command.type === "task";
  if (
    ![options.outputDirectory, options.workRoot, options.home].every(isAbsolute) ||
    !Number.isSafeInteger(options.resultsGid) ||
    options.resultsGid < 0 ||
    repository !== (options.repositoryBundle !== undefined) ||
    (task && command.repository !== undefined) !== (options.repositorySnapshot !== undefined)
  )
    throw new Error("Invalid runner worker configuration");
  for (const provider of [".codex", ".claude"]) {
    mkdirSync(join(options.home, provider), { recursive: true, mode: 0o700 });
    chmodSync(join(options.home, provider), 0o700);
  }
  options.signal?.throwIfAborted();
  for (const [name, kind] of [
    ["events.jsonl", "journal"],
    ["result.json", "result"],
  ] as const) {
    try {
      lstatSync(join(options.outputDirectory, name));
      throw new Error(`Runner ${kind} already exists`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const claim = outputFile(options.outputDirectory, ".worker-claim", options.resultsGid);
  try {
    fsyncSync(claim);
  } finally {
    closeSync(claim);
  }
  const journalName = `.events-${randomUUID()}.tmp`;
  const journalPath = join(options.outputDirectory, journalName);
  let journal: number | undefined;
  try {
    journal = outputFile(options.outputDirectory, journalName, options.resultsGid);
    fsyncSync(journal);
    renameSync(journalPath, join(options.outputDirectory, "events.jsonl"));
    const directory = openSync(options.outputDirectory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch (error) {
    if (journal !== undefined) closeSync(journal);
    throw error;
  } finally {
    rmSync(journalPath, { force: true });
  }
  const eventJournal = journal;
  let journalSize = 0;
  function emit(event: RunnerWorkerEvent): void {
    const line = `${JSON.stringify(event)}\n`;
    const length = Buffer.byteLength(line);
    if (length > 262_144 || journalSize + length > 16_777_216)
      throw new Error("Runner event journal exceeds size limit");
    writeFileSync(eventJournal, line);
    fsyncSync(eventJournal);
    journalSize += length;
  }
  let skillsRoot: string | undefined;
  try {
    if (command.type === "login") {
      if (!options.answer || !options.signal) throw new Error("Login lifecycle is unavailable");
      await runProviderLogin({
        agent: command.agent,
        home: options.home,
        signal: options.signal,
        answer: options.answer,
        emit: (update) => emit({ type: "login", update }),
      });
      return {
        executionId: job.executionId,
        commandId: command.id,
        run: {
          role: "implementer",
          stopReason: "end_turn",
          cancelled: false,
          timedOut: false,
          authRequired: false,
          agentExited: true,
        },
      };
    }
    if (!task) mkdirSync(options.workRoot, { recursive: true, mode: 0o700 });
    const worktree = join(options.workRoot, job.executionId);
    if (task) {
      const directory = openSync(
        worktree,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        const info = fstatSync(directory);
        if (
          info.uid !== process.getuid!() ||
          info.gid !== process.getgid!() ||
          (info.mode & 0o7777) !== 0o700
        )
          throw new Error("Unsafe runner task workspace");
      } finally {
        closeSync(directory);
      }
      if (options.repositorySnapshot) {
        const repositoryPath = join(worktree, "repository");
        cpSync(options.repositorySnapshot, repositoryPath, {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
        function makeWritable(path: string): void {
          const info = lstatSync(path);
          if (info.isDirectory()) {
            chmodSync(path, 0o700);
            for (const name of readdirSync(path)) makeWritable(join(path, name));
          } else if (info.isFile()) chmodSync(path, 0o600 | (info.mode & 0o111));
          else throw new Error("Invalid runner repository entry");
        }
        makeWritable(repositoryPath);
      }
    }
    const env = {
      PATH: "/usr/bin:/bin",
      HOME: options.home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
    const invokeGit = (args: string[]) => git(args, { env, signal: options.signal });
    if (repository) {
      const bundle = openSync(
        options.repositoryBundle!,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = fstatSync(bundle);
        if (!info.isFile() || info.size === 0 || info.size > 536_870_912)
          throw new Error("Invalid runner repository bundle");
      } finally {
        closeSync(bundle);
      }
      await invokeGit([
        "-c",
        "core.hooksPath=/dev/null",
        "clone",
        "--no-checkout",
        "--",
        options.repositoryBundle!,
        worktree,
      ]);
      const base = (
        await invokeGit([
          "-C",
          worktree,
          "rev-parse",
          "--verify",
          `${command.repository.baseSha}^{commit}`,
        ])
      ).trim();
      if (base !== command.repository.baseSha) throw new Error("Runner repository base mismatch");
      await invokeGit(["-C", worktree, "config", "core.hooksPath", "/dev/null"]);
      await invokeGit([
        "-C",
        worktree,
        "symbolic-ref",
        "HEAD",
        `refs/heads/paws/${job.executionId}`,
      ]);
      await invokeGit(["-C", worktree, "update-ref", "HEAD", base]);
      options.signal?.throwIfAborted();
      await checkoutPatterns(
        worktree,
        exclusionPatterns(command.repository.checkoutExclusions ?? []),
        env,
      );
      options.signal?.throwIfAborted();
      await invokeGit(["-C", worktree, "remote", "remove", "origin"]);
    } else if (!task) {
      mkdirSync(worktree, { mode: 0o700 });
    }
    let inputFiles = options.inputs?.inputFiles ?? [];
    if (command.type === "run" || command.type === "review" || command.type === "task") {
      const descriptors = command.inputFiles ?? [];
      const preparedPrompt = options.inputs?.prompt ?? command.prompt;
      const promptBytes = Buffer.from(preparedPrompt);
      if (
        inputFiles.length !== descriptors.length ||
        inputFiles.some(
          (file, index) =>
            file.path !== descriptors[index]!.path ||
            file.mimeType !== descriptors[index]!.mimeType ||
            file.bytes.length !== descriptors[index]!.sizeBytes ||
            createHash("sha256").update(file.bytes).digest("hex") !== descriptors[index]!.sha256,
        ) ||
        (command.promptContext
          ? promptBytes.length !== command.promptContext.sizeBytes ||
            createHash("sha256").update(promptBytes).digest("hex") !==
              command.promptContext.sha256 ||
            promptBytes.toString("utf8") !== preparedPrompt
          : preparedPrompt !== command.prompt)
      )
        throw new Error("Runner input contents are required");
      if (command.type === "run" && command.skillsInputId !== undefined) {
        skillsRoot = materializeImplementationSkills(
          inputFiles[command.skillsInputId]!.bytes,
          options.workRoot,
        );
        inputFiles = inputFiles.filter((_, index) => index !== command.skillsInputId);
      }
      for (const file of inputFiles) {
        const parts = file.path.split("/");
        let parent = worktree;
        for (const part of parts.slice(0, -1)) {
          parent = join(parent, part);
          try {
            mkdirSync(parent, { mode: 0o700 });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
          const info = lstatSync(parent);
          if (!info.isDirectory() || info.isSymbolicLink())
            throw new Error("Unsafe runner input workspace");
        }
        writeFileSync(join(worktree, file.path), file.bytes, { flag: "wx", mode: 0o600 });
      }
    }
    let reviewText = "";
    let eventFailure: Error | undefined;
    const agentEnv = minimalAgentEnv({
      PATH: "/opt/paws-runner/bin:/usr/local/bin:/usr/bin:/bin",
      ...options.launch?.env,
      HOME: options.home,
      ...(command.memberId
        ? {
            CODEX_HOME: join(options.home, ".codex"),
            CLAUDE_CONFIG_DIR: join(options.home, ".claude"),
          }
        : {}),
    });
    const run = await runAgent({
      ...options.launch,
      hostAccess: true,
      skillsRoot,
      env: agentEnv,
      checkpointEnv: env,
      commitPolicy: command.type === "run" ? command.commitPolicy : undefined,
      checkpointIdentity:
        command.type === "run" && command.checkpointBot
          ? appBotCommitIdentity(command.checkpointBot)
          : undefined,
      checkpointExcludePaths: inputFiles.map((file) => file.path),
      profile:
        command.type === "login_check" ? { agent: command.agent, model: null } : command.profile,
      role: command.type === "review" ? "reviewer" : "implementer",
      readOnly: command.type === "task" ? command.purpose === "answer" : command.type !== "run",
      checkpoint: command.type === "run",
      prepareOnly: !repository && command.type !== "helper" && !task,
      itemId: repository || task ? command.itemId : job.executionId,
      runId: job.executionId,
      prompt:
        repository || task || command.type === "helper"
          ? (options.inputs?.prompt ?? command.prompt)
          : "Check agent connection.",
      inputFiles: inputFiles.map((file) => ({ ...file, path: join(worktree, file.path) })),
      worktreePath: worktree,
      pawsRoot: join(task ? worktree : options.workRoot, ".paws"),
      home: options.home,
      signal: options.signal,
      onEvent(event) {
        try {
          if (
            (command.type === "review" || command.type === "helper") &&
            event.type === "session_update" &&
            event.update.sessionUpdate === "agent_message_chunk" &&
            event.update.content.type === "text"
          ) {
            reviewText += event.update.content.text;
            if (command.type === "helper") RunnerHelperResultSchema.shape.text.parse(reviewText);
            else if (Buffer.byteLength(reviewText) > 524_288)
              throw new Error("Runner response exceeds size limit");
          }
          emit({ type: "acp", event });
        } catch (error) {
          eventFailure = error instanceof Error ? error : new Error(String(error));
          throw error;
        }
      },
      publishArtifact: (task ? command.purpose === "artifact" : repository)
        ? {
            async publish(snapshot, context) {
              if (!options.answer) throw new Error("Runner artifact publication is unavailable");
              const bytes = Buffer.from(await snapshot.bytes.arrayBuffer());
              context.signal.throwIfAborted();
              const artifact = RunnerArtifactSchema.parse({
                id: randomUUID(),
                path: snapshot.path,
                displayName: snapshot.displayName,
                mimeType: snapshot.mimeType,
                sizeBytes: snapshot.sizeBytes,
                sha256: snapshot.sha256,
                attachToIssue: context.request?.attachToIssue ?? false,
              });
              if (
                bytes.length !== artifact.sizeBytes ||
                createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
              )
                throw new Error("Runner artifact snapshot changed");
              const file = outputFile(
                options.outputDirectory,
                `artifact-${artifact.id}.bytes`,
                options.resultsGid,
              );
              try {
                writeFileSync(file, bytes);
                fsyncSync(file);
              } finally {
                closeSync(file);
              }
              emit({ type: "artifact", requestId: artifact.id, artifact });
              const reply = await options.answer(artifact.id, context.signal);
              context.signal.throwIfAborted();
              const publication = JSON.parse(reply.answer) as { url?: unknown };
              if (typeof publication.url !== "string")
                throw new Error("Runner artifact publication response is invalid");
              return { url: publication.url };
            },
          }
        : undefined,
      updatePlan:
        command.type === "run" || command.type === "task"
          ? {
              async update(steps) {
                const parsed = RunnerEventSchema.safeParse({ type: "plan", steps });
                if (!parsed.success || parsed.data.type !== "plan")
                  throw new Error("update_plan requires 1 to 16 steps with content and status");
                emit(parsed.data);
              },
            }
          : undefined,
      pullRequest:
        command.type === "run"
          ? {
              async update(description) {
                const parsed = RunnerEventSchema.safeParse({
                  type: "pull_request",
                  ...description,
                });
                if (!parsed.success || parsed.data.type !== "pull_request")
                  throw new Error("open_pull_request requires a title and a body");
                emit(parsed.data);
              },
            }
          : undefined,
      askTeam:
        command.type === "helper"
          ? undefined
          : {
              async ask(request, context) {
                if (!options.answer) throw new Error("Runner question channel is unavailable");
                const requestId = randomUUID();
                emit({
                  type: "question",
                  requestId,
                  question: request.question,
                  options: request.options ?? [],
                });
                return options.answer(requestId, context.signal);
              },
            },
    });
    if (eventFailure) throw eventFailure;
    if (command.type === "review" && Buffer.byteLength(reviewText) > 524_288)
      throw new Error("Runner response exceeds size limit");
    const result: RunnerWorkerResult = { executionId: job.executionId, commandId: command.id, run };
    if (command.type === "helper") result.text = reviewText;
    if (command.type === "login_check") {
      const checked =
        command.agent === "grok"
          ? null
          : await checkDeveloperLogin({
              cli: command.agent,
              env: agentEnv,
              run: options.loginCommand,
            });
      const authenticated =
        run.stopReason === "end_turn" &&
        !run.authRequired &&
        !run.errorMessage &&
        (checked?.loggedIn ?? Boolean(run.identity));
      result.login = {
        agent: command.agent,
        authenticated,
        method: !authenticated
          ? "none"
          : checked?.authMethod === "api_key" || checked?.authMethod === "api_key_helper"
            ? "api_key"
            : checked?.authMethod === "claude.ai" || checked?.authMethod === "oauth_token"
              ? "subscription"
              : "other",
        command:
          command.agent === "claude"
            ? "claude auth login"
            : command.agent === "codex"
              ? "codex login --device-auth"
              : "grok login",
      };
    }
    if (repository && run.stopReason === "end_turn" && !run.errorMessage && run.agentExited) {
      const sha = (await invokeGit(["-C", worktree, "rev-parse", "HEAD"])).trim();
      if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid runner candidate commit");
      await invokeGit([
        "-C",
        worktree,
        "merge-base",
        "--is-ancestor",
        command.repository.baseSha,
        sha,
      ]);
      if (command.type === "run") {
        if (command.commitPolicy)
          await validateCandidateAttribution(
            worktree,
            command.repository.baseSha,
            sha,
            command.commitPolicy,
            env,
            options.signal,
          );
        result.candidateSha = sha;
        if (sha !== command.repository.baseSha) {
          const candidatePath = join(options.outputDirectory, "candidate.bundle");
          const fd = outputFile(options.outputDirectory, "candidate.bundle", options.resultsGid);
          closeSync(fd);
          await invokeGit([
            "-C",
            worktree,
            "bundle",
            "create",
            candidatePath,
            "HEAD",
            `^${command.repository.baseSha}`,
          ]);
          const candidate = openSync(candidatePath, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const info = fstatSync(candidate);
            if (!info.isFile() || info.size > 536_870_912)
              throw new Error("Runner candidate exceeds size limit");
            fchownSync(candidate, process.getuid!(), options.resultsGid);
            fchmodSync(candidate, 0o640);
            fsyncSync(candidate);
          } finally {
            closeSync(candidate);
          }
        }
      } else result.reviewText = reviewText;
    }
    const serialized = JSON.stringify(
      command.type === "helper"
        ? {
            ...result,
            run: RunnerHelperResultSchema.omit({
              executionId: true,
              commandId: true,
              text: true,
            })
              .strip()
              .parse(run),
          }
        : result,
    );
    if (Buffer.byteLength(serialized) > 1_048_576)
      throw new Error("Runner result exceeds size limit");
    const stagingName = `.result-${randomUUID()}.tmp`;
    const stagingPath = join(options.outputDirectory, stagingName);
    try {
      const final = outputFile(options.outputDirectory, stagingName, options.resultsGid);
      try {
        writeFileSync(final, serialized);
        fsyncSync(final);
      } finally {
        closeSync(final);
      }
      renameSync(stagingPath, join(options.outputDirectory, "result.json"));
    } finally {
      rmSync(stagingPath, { force: true });
    }
    const directory = openSync(
      options.outputDirectory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    return result;
  } finally {
    if (skillsRoot) rmSync(skillsRoot, { recursive: true, force: true });
    closeSync(journal);
  }
}

export async function runRunnerWorker(options: {
  executionId: string;
  spool: RunnerSpool;
  results: RunnerResults;
  workRoot: string;
  home: string;
  signal?: AbortSignal;
}): Promise<RunnerWorkerResult> {
  if (process.getuid?.() === 0 || process.getuid?.() !== options.results.agentUid)
    throw new Error("Runner worker identity is invalid");
  const spool = options.spool;
  const job = readRunnerJob(spool, options.executionId);
  return executeRunnerCommand({
    job,
    inputs: readRunnerJobInputs(spool, options.executionId),
    ...(job.command.type === "run" || job.command.type === "review"
      ? { repositoryBundle: runnerRepositoryBundlePath(spool, options.executionId) }
      : job.command.type === "task" && job.command.repository
        ? { repositorySnapshot: runnerTaskRepositoryPath(spool, options.executionId) }
        : {}),
    outputDirectory: runnerResultDirectory(options.results, options.executionId),
    workRoot: job.command.type === "task" ? "/var/lib/paws-agent-tasks" : options.workRoot,
    home: options.home,
    resultsGid: options.results.resultsGid,
    signal: options.signal,
    async answer(requestId, signal) {
      while (true) {
        signal.throwIfAborted();
        const answer = readRunnerAnswer(spool, options.executionId, requestId);
        if (answer) return { answer: answer.answer };
        await delay(250, undefined, { signal });
      }
    },
  });
}
