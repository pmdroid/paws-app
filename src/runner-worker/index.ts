import { journalCaught } from "../journal";
import { runProviderLogin } from "../runner-login-worker";
import type { RunnerLoginUpdate } from "../runner-protocol";
import { checkoutPatterns, exclusionPatterns } from "../worktree-checkout";
import { createReviewCommandRunner, runReviewCommand } from "../closeout-spec";
import {
  closeSync,
  chmodSync,
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
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
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { join, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  appBotCommitIdentity,
  createUpdateLimiter,
  validateCandidateAttribution,
  assertDescendsFromAny,
  candidateBases,
  CHECKPOINT_COMMIT_MESSAGE,
  ArtifactRejectedError,
  commitCheckpoint,
  commitPolicyMessage,
  snapshotWorktree,
  FOLLOW_UP_INTERRUPTION,
  createAcpPromptLifecycle,
  git,
  runAgent,
  runWithShellRecovery,
  minimalAgentEnv,
  reconstructAcpPrompt,
  currentRequest,
  recoverAcpConversation,
  materializeImplementationSkills,
  type AcpEvent,
  type RunAgentOptions,
  type RunAgentResult,
  decodePolicyFiles,
  decodePolicyChunk,
  providerCliPath,
  type PolicyFilesLoad,
} from "../acp";
import {
  readRunnerJob,
  readRunnerJobInputs,
  type RunnerJobInputs,
  runnerRepositoryBundlePath,
  runnerSessionBundlePath,
  runnerTaskRepositoryPath,
  runnerResultDirectory,
  RunnerJobSchema,
  type RunnerJob,
  type RunnerResults,
  type RunnerSpool,
} from "../runner-execution";
import {
  readRunnerAnswer,
  runnerFollowUpRequestId,
  runnerHandoverRequestId,
  runnerCheckpointRequestId,
  runnerCheckpointPublishedId,
} from "../runner-answers";
import {
  installRuntimes,
  prependRuntimePath,
  runnerMiseDirectories,
  withoutRunnerBin,
} from "../runner-mise";
import {
  checkDeveloperLogin,
  claudeLimits,
  codexLimits,
  readCodexRateLimits,
  type AgentLimit,
  type CodexRateLimitReader,
  type LoginCommandRunner,
} from "../install";
import {
  RUNNER_ARTIFACT_COUNT_LIMIT,
  RunnerArtifactSchema,
  RunnerEventSchema,
  RunnerHelperResultSchema,
  RUNNER_SKILL_FOLDERS,
  type RunnerArtifact,
  type RunnerEvent,
  type RunnerHandoverFailure,
  type RunnerInstalledRuntime,
} from "../runner-protocol";

import { AGENT_SESSION_MAX_BYTES } from "../agent-sessions";
import { compactAcpEvent } from "./compact";
import {
  CLAUDE_SESSION_TOO_LARGE,
  CODEX_SESSION_TOO_LARGE,
  GROK_SESSION_TOO_LARGE,
  SESSION_BUNDLE_FILE,
  SESSION_METADATA_FILE,
  SessionTooLargeError,
  writeClaudeSessionBundle,
  writeCodexSessionBundle,
  writeGrokSessionBundle,
} from "./session-snapshot";
import {
  removeRestoredSession,
  restoreClaudeSessionBundle,
  restoreCodexSessionBundle,
  restoreGrokSessionBundle,
  SessionIntegrityError,
  type RestoredAgentSession,
} from "./session-restore";

export {
  compactAcpEvent,
  SESSION_BUNDLE_FILE,
  SESSION_METADATA_FILE,
  CLAUDE_SESSION_TOO_LARGE,
  CODEX_SESSION_TOO_LARGE,
  GROK_SESSION_TOO_LARGE,
  writeClaudeSessionBundle,
  writeCodexSessionBundle,
  writeGrokSessionBundle,
  restoreClaudeSessionBundle,
  restoreCodexSessionBundle,
  restoreGrokSessionBundle,
};

export interface RunnerWorkerOptions {
  job: RunnerJob;
  repositoryBundle?: string;
  repositorySnapshot?: string;
  /** The session snapshot a moved run restores, when the runner could download it. */
  sessionBundle?: string;
  inputs?: RunnerJobInputs;
  outputDirectory: string;
  workRoot: string;
  home: string;
  resultsGid: number;
  signal?: AbortSignal;
  launch?: Pick<RunAgentOptions, "command" | "args" | "env">;
  answer?: (requestId: string, signal: AbortSignal) => Promise<{ answer: string }>;
  followUp?: (sequence: number, signal: AbortSignal) => Promise<string>;
  loginCommand?: LoginCommandRunner;
  codexRateLimits?: CodexRateLimitReader;
  resume?: boolean;
  skills?: string;
  /** The mise binary and install cap. Tests point these at a fake. */
  mise?: { path?: string; timeoutMs?: number };
  /** Where the `claude` and `codex` CLIs are. Defaults to the runner's installed launchers. */
  providerCli?: (cli: "claude" | "codex") => string;
  /** The largest gzipped Claude session bundle. Tests lower it. */
  sessionSnapshotMaxBytes?: number;
  /**
   * Resolves once Paws asks for the `sequence`th handover of this run, with the time (ms since
   * the epoch) by which that handover must finish.
   */
  handover?: (sequence: number, signal: AbortSignal) => Promise<{ deadline: number }>;
  /** How long each step after a handover's interrupt may take. Tests lower it. */
  handoverStepTimeoutMs?: number;
  /** Resolves once Paws asks for the `sequence`th checkpoint of this run; the first stops it. */
  checkpoint?: (sequence: number, signal: AbortSignal) => Promise<void>;
  /**
   * The commit the runner pushed as this run's `sequence`th checkpoint, or null while it has not.
   * Without it, every emitted checkpoint counts as published.
   */
  checkpointPublished?: (sequence: number) => string | null;
  /** How often a running turn publishes a WIP commit when its worktree changed. Tests lower it. */
  checkpointIntervalMs?: number;
}

/** A turn that runs this long loses at most this much work to a runner crash or upgrade. */
export const CHECKPOINT_INTERVAL_MS = 20 * 60_000;

export { CHECKPOINT_COMMIT_MESSAGE };

/**
 * Each step after a handover stopped the agent, the WIP commit, the session snapshot and the
 * candidate bundle, has this long. The handover's own deadline only bounds the safe-point wait.
 */
export const HANDOVER_STEP_TIMEOUT_MS = 60_000;

export const HANDOVER_COMMIT_MESSAGE =
  "Save work in progress to hand the session to another runner";

export const RESUME_PROMPT =
  "The agent process stopped unexpectedly. Check git status and the workspace, then continue where you left off.";

export async function runWithFollowUps(
  agent: RunAgentOptions,
  next: (sequence: number, signal: AbortSignal) => Promise<string>,
  runner: (options: RunAgentOptions) => Promise<RunAgentResult> = runAgent,
): Promise<RunAgentResult> {
  const lifecycle = createAcpPromptLifecycle([], runner);
  let prompt = agent.prompt;
  for (let sequence = 1; ; sequence++) {
    const waiting = new AbortController();
    const signal = agent.signal ? AbortSignal.any([waiting.signal, agent.signal]) : waiting.signal;
    const turn = lifecycle.prompt({ ...agent, prompt });
    const message = next(sequence, signal).then(
      (text) => ({ text }),
      (caughtError1) => {
        journalCaught(caughtError1, "runner-worker.runWithFollowUps.next", null);
        return null;
      },
    );
    const first = await Promise.race([turn.then((result) => ({ result })), message]);
    if (first === null || "result" in first) {
      waiting.abort();
      return first?.result ?? turn;
    }
    await lifecycle.interrupt();
    prompt = first.text;
  }
}

export function remoteCloseoutPolicy(
  emit: (event: {
    type: "closeout_policy";
    requestId: string;
    offset?: number;
    hash?: string;
  }) => void,
  answer: (requestId: string, signal: AbortSignal) => Promise<{ answer: string }>,
  signal: AbortSignal,
): () => Promise<PolicyFilesLoad> {
  return async () => {
    try {
      let content = "";
      let hash: string | undefined;
      let total: number | undefined;
      do {
        const requestId = randomUUID();
        emit({
          type: "closeout_policy",
          requestId,
          offset: content.length,
          ...(hash ? { hash } : {}),
        });
        const response = (await answer(requestId, signal)).answer;
        const chunk = decodePolicyChunk(response);
        if (!chunk) {
          const result = decodePolicyFiles(response);
          return content.length === 0 || !result.ok
            ? result
            : { ok: false, message: "Paws sent an invalid Closeout policy chunk" };
        }
        if (
          chunk.offset !== content.length ||
          (hash !== undefined && chunk.hash !== hash) ||
          (total !== undefined && chunk.total !== total) ||
          chunk.offset + chunk.data.length > chunk.total
        )
          return { ok: false, message: "Paws sent an invalid Closeout policy chunk" };
        hash = chunk.hash;
        total = chunk.total;
        content += chunk.data;
      } while (content.length < total);
      if (createHash("sha256").update(content).digest("hex") !== hash)
        return { ok: false, message: "Paws sent an invalid Closeout policy chunk" };
      return decodePolicyFiles(content);
    } catch (error) {
      signal.throwIfAborted();
      journalCaught(error, "runner-worker.remoteCloseoutPolicy.emit", null);
      return {
        ok: false,
        message: `Paws could not provide the Closeout policy: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}

export type RunnerWorkerEvent =
  | { type: "login"; update: RunnerLoginUpdate }
  | { type: "closeout_policy"; requestId: string; offset?: number; hash?: string }
  | { type: "acp"; event: AcpEvent }
  | {
      type: "question";
      requestId: string;
      question: string;
      context?: string;
      options: readonly unknown[];
    }
  | { type: "artifact"; requestId: string; artifact: RunnerArtifact }
  | Extract<
      RunnerEvent,
      {
        type:
          | "plan"
          | "pull_request"
          | "progress"
          | "closeout"
          | "hook_failed"
          | "session_restore"
          | "handover"
          | "handover_interrupted"
          | "checkpoint";
      }
    >;

export interface RunnerWorkerResult {
  executionId: string;
  commandId: string;
  run: RunAgentResult & { agentLimits?: AgentLimit[] };
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

const ACTIVITY_JOURNAL_LIMIT = 15 * 1024 * 1024;

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

/** Write `name` in the output directory through a staging file, replacing an earlier copy. */
function replaceOutputFile(
  options: { outputDirectory: string; resultsGid: number },
  name: string,
  contents: string,
): void {
  const stagingName = `.${name}-${randomUUID()}.tmp`;
  const stagingPath = join(options.outputDirectory, stagingName);
  try {
    const fd = outputFile(options.outputDirectory, stagingName, options.resultsGid);
    try {
      writeFileSync(fd, contents);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(stagingPath, join(options.outputDirectory, name));
  } finally {
    rmSync(stagingPath, { force: true });
  }
}

function createJournal(options: { outputDirectory: string; resultsGid: number }): number {
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
    return journal;
  } catch (error) {
    if (journal !== undefined) closeSync(journal);
    throw error;
  } finally {
    rmSync(journalPath, { force: true });
  }
}

function appendJournal(directory: string): number {
  rmSync(join(directory, "candidate.bundle"), { force: true });
  return openSync(
    join(directory, "events.jsonl"),
    constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
  );
}

/** Removes an earlier command's checkout of the same run, so the new one is never merged into it. */
function removeLeftoverCheckout(path: string): void {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid!())
    throw new Error("Unsafe runner workspace");
  function remove(entry: string): void {
    const entryInfo = lstatSync(entry);
    if (!entryInfo.isDirectory()) return unlinkSync(entry);
    // Agents may leave read-only folders; never follow a link while making them removable.
    chmodSync(entry, 0o700);
    for (const name of readdirSync(entry)) remove(join(entry, name));
    rmdirSync(entry);
  }
  remove(path);
}

/**
 * Bundles the Claude, Codex or Grok session a run's turn used into the output directory, with a
 * description the runner runtime uploads. A bundle over the cap is skipped with a notice. Any
 * other failure is logged without contents and never fails the run.
 */
async function snapshotAgentSession(
  options: RunnerWorkerOptions,
  executionId: string,
  agent: SessionAgent,
  session: {
    sessionId: string;
    workspacePath: string;
    commitSha: string;
    turn: number;
  },
  emit: (event: RunnerWorkerEvent) => void,
): Promise<void> {
  const stagingName = `.session-${randomUUID()}.tmp`;
  const stagingPath = join(options.outputDirectory, stagingName);
  try {
    const fd = outputFile(options.outputDirectory, stagingName, options.resultsGid);
    let bundle: Awaited<ReturnType<typeof writeClaudeSessionBundle>>;
    try {
      const target = {
        home: options.home,
        sessionId: session.sessionId,
        output: fd,
        maxBytes: Math.min(
          options.sessionSnapshotMaxBytes ?? AGENT_SESSION_MAX_BYTES,
          AGENT_SESSION_MAX_BYTES,
        ),
      };
      bundle =
        agent === "codex"
          ? await writeCodexSessionBundle(target)
          : agent === "grok"
            ? await writeGrokSessionBundle({ ...target, cwd: session.workspacePath })
            : await writeClaudeSessionBundle({ ...target, cwd: session.workspacePath });
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (!bundle) {
      console.warn(JSON.stringify({ event: "agent_session_snapshot_missing", executionId }));
      return;
    }
    renameSync(stagingPath, join(options.outputDirectory, SESSION_BUNDLE_FILE));
    replaceOutputFile(
      options,
      SESSION_METADATA_FILE,
      JSON.stringify({
        agent,
        ...session,
        sizeBytes: bundle.sizeBytes,
        sha256: bundle.sha256,
      }),
    );
    console.warn(
      JSON.stringify({
        event: "agent_session_snapshot",
        executionId,
        files: bundle.files.length,
        refused: bundle.refused,
        sizeBytes: bundle.sizeBytes,
      }),
    );
  } catch (error) {
    if (error instanceof SessionTooLargeError) {
      console.warn(JSON.stringify({ event: "agent_session_snapshot_too_large", executionId }));
      try {
        emit({
          type: "progress",
          text: SESSION_TOO_LARGE[agent],
          notice: true,
        });
      } catch (caught) {
        journalCaught(caught, "runner-worker.snapshotAgentSession.notice", null);
      }
      return;
    }
    console.warn(
      JSON.stringify({
        event: "agent_session_snapshot_failed",
        executionId,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  } finally {
    rmSync(stagingPath, { force: true });
  }
}

/** The agents whose native session a run snapshots at turn end and restores on a move. */
type SessionAgent = "claude" | "codex" | "grok";
const SESSION_TOO_LARGE: Record<SessionAgent, string> = {
  claude: CLAUDE_SESSION_TOO_LARGE,
  codex: CODEX_SESSION_TOO_LARGE,
  grok: GROK_SESSION_TOO_LARGE,
};

function resumedSession(directory: string): string | undefined {
  let sessionId: string | undefined;
  for (const line of readFileSync(join(directory, "events.jsonl"), "utf8").split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; event?: AcpEvent };
      if (entry.type === "acp" && entry.event?.type === "session_started")
        sessionId = entry.event.sessionId;
    } catch (caughtError1) {
      journalCaught(caughtError1, "runner-worker.resumedSession.parse", null);
    }
  }
  return sessionId;
}

/**
 * A reviewer turn as the agent's own review command of `base..HEAD`, run in the run's checkout
 * with the runner's login: `codex exec review --base` or Claude `/code-review`. The command's
 * read-only review is the sandbox. The parsed findings are the review text.
 */
async function reviewCommandTurn(input: {
  agent: "claude" | "codex";
  model: string;
  base: string;
  head: string;
  worktree: string;
  executable: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  onText: (text: string) => void;
}): Promise<RunAgentResult> {
  const outcome = await runReviewCommand(
    createReviewCommandRunner({
      env: input.env,
      timeoutMs: input.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    }),
    {
      agent: input.agent,
      model: input.model,
      command: input.executable,
      base: input.base,
      head: input.head,
      cwd: input.worktree,
    },
  );
  const cancelled = input.signal?.aborted === true;
  const ended = {
    role: "reviewer" as const,
    identity: outcome.producer,
    ...(outcome.producer.session ? { sessionId: outcome.producer.session } : {}),
    timedOut: false,
    cancelled,
    authRequired: false,
    agentExited: true,
  };
  if (cancelled) return { ...ended, stopReason: "cancelled", errorMessage: "Review cancelled" };
  if (!outcome.ok) return { ...ended, stopReason: "error", errorMessage: outcome.reason };
  input.onText(JSON.stringify(outcome.findings));
  return { ...ended, stopReason: "end_turn" };
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
    (options.skills !== undefined && !isAbsolute(options.skills)) ||
    !Number.isSafeInteger(options.resultsGid) ||
    options.resultsGid < 0 ||
    repository !== (options.repositoryBundle !== undefined) ||
    (task && command.repository !== undefined) !== (options.repositorySnapshot !== undefined)
  )
    throw new Error("Invalid runner worker configuration");
  for (const provider of [".codex", ".claude", ".grok"]) {
    mkdirSync(join(options.home, provider), { recursive: true, mode: 0o700 });
    chmodSync(join(options.home, provider), 0o700);
  }
  // A run's Codex home links each entry of `.codex`; a missing `sessions` folder would leave
  // the rollout in that run's own folder, where the turn-end snapshot can't find it.
  mkdirSync(join(options.home, ".codex", "sessions"), { recursive: true, mode: 0o700 });
  options.signal?.throwIfAborted();
  for (const [name, kind] of [
    ...(options.resume ? [] : [["events.jsonl", "journal"] as const]),
    ["result.json", "result"] as const,
  ]) {
    try {
      lstatSync(join(options.outputDirectory, name));
      throw new Error(`Runner ${kind} already exists`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      journalCaught(
        error,
        "runner-worker.executeRunnerCommand.lstatSync",
        "itemId" in command ? command.itemId : null,
        "optional file may be absent",
      );
    }
  }
  const resumed = options.resume === true;
  const resumedId = resumed ? resumedSession(options.outputDirectory) : undefined;
  if (!resumed) {
    const claim = outputFile(options.outputDirectory, ".worker-claim", options.resultsGid);
    try {
      fsyncSync(claim);
    } finally {
      closeSync(claim);
    }
  }
  const eventJournal = resumed ? appendJournal(options.outputDirectory) : createJournal(options);
  let journalSize = fstatSync(eventJournal).size;
  let activityOmitted = false;
  const updates = createUpdateLimiter();
  function emit(event: RunnerWorkerEvent): void {
    const line = `${JSON.stringify(event)}\n`;
    const length = Buffer.byteLength(line);
    if (event.type === "acp" && journalSize + length > ACTIVITY_JOURNAL_LIMIT) {
      if (activityOmitted) return;
      activityOmitted = true;
      emit({
        type: "progress",
        text: "The run's event journal is nearly full. Later agent activity is omitted.",
      });
      return;
    }
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
    // A run checks out at one path on every runner so cwd-keyed agent sessions keep their key.
    const worktree = join(
      options.workRoot,
      command.type === "run" ? command.runId : job.executionId,
    );
    if (command.type === "run" && !resumed) removeLeftoverCheckout(worktree);
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
      if (options.repositorySnapshot && !resumed) {
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
    if (resumed) {
      if (!lstatSync(worktree).isDirectory()) throw new Error("Runner workspace is missing");
    } else if (repository) {
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
      const main = command.repository.mainSha ?? base;
      if (
        (await invokeGit(["-C", worktree, "rev-parse", "--verify", `${main}^{commit}`])).trim() !==
        main
      )
        throw new Error("Runner repository main mismatch");
      await invokeGit(["-C", worktree, "update-ref", "refs/remotes/origin/main", main]);
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
      for (const file of resumed ? [] : inputFiles) {
        const parts = file.path.split("/");
        let parent = worktree;
        for (const part of parts.slice(0, -1)) {
          parent = join(parent, part);
          try {
            mkdirSync(parent, { mode: 0o700 });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            journalCaught(
              error,
              "runner-worker.executeRunnerCommand.mkdirSync",
              command.itemId,
              "path may already exist",
            );
          }
          const info = lstatSync(parent);
          if (!info.isDirectory() || info.isSymbolicLink())
            throw new Error("Unsafe runner input workspace");
        }
        writeFileSync(join(worktree, file.path), file.bytes, { flag: "wx", mode: 0o600 });
      }
    }
    const installed = await installCommandRuntimes(command, job.executionId, options, emit);
    const installFailure = installed.failure;
    let reviewText = "";
    let agentLimits: AgentLimit[] = [];
    let tokens = 0;
    let eventFailure: Error | undefined;
    let artifactsPublished = 0;
    const mise = runnerMiseDirectories(options.home);
    const providerCli = options.providerCli ?? ((cli: "claude" | "codex") => providerCliPath(cli));
    // The runner's own bin folder (its Bun, mise, launchers) never reaches the task. Paws starts
    // those by absolute path; a repo that needs Bun declares it in mise.toml.
    const agentEnv = minimalAgentEnv({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      ...options.launch?.env,
      HOME: options.home,
      CODEX_HOME: join(options.home, ".codex"),
      CLAUDE_CONFIG_DIR: join(options.home, ".claude"),
      MISE_DATA_DIR: mise.dataDir,
      MISE_CACHE_DIR: mise.cacheDir,
    });
    agentEnv.PATH = withoutRunnerBin(agentEnv.PATH);
    const closeoutBasePath = withoutRunnerBin(process.env.PATH);
    // Pinned bin dirs, not shims: nothing on PATH reads the repository's mise config.
    if (installed.binPaths.length)
      agentEnv.PATH = prependRuntimePath(installed.binPaths, agentEnv.PATH);
    const prompt =
      repository || task || command.type === "helper"
        ? (options.inputs?.prompt ?? command.prompt)
        : "Check agent connection.";
    if (resumed) emit({ type: "progress", text: "The agent restarted after a crash." });
    // A moved run unpacks its saved session at the same paths before the agent starts. Paws
    // learns once whether the agent loaded it; otherwise the run starts a new session.
    const restoreRequest =
      command.type === "run" && !resumed && command.profile.agent === command.restoreSession?.agent
        ? command.restoreSession
        : undefined;
    let restored: RestoredAgentSession | undefined;
    let restoreReported = false;
    const reportRestore = (
      outcome:
        | { restored: true }
        | { restored: false; reason: "download" | "integrity" | "unpack" | "load" },
    ) => {
      if (restoreReported) return;
      restoreReported = true;
      if (!outcome.restored && restored) removeRestoredSession(options.home, restored);
      emit({ type: "session_restore", ...outcome });
    };
    if (restoreRequest) {
      if (!options.sessionBundle) reportRestore({ restored: false, reason: "download" });
      else
        try {
          const source = {
            bundle: options.sessionBundle,
            home: options.home,
            sessionId: restoreRequest.sessionId,
            sizeBytes: restoreRequest.sizeBytes,
            sha256: restoreRequest.sha256,
          };
          restored =
            restoreRequest.agent === "codex"
              ? await restoreCodexSessionBundle(source)
              : restoreRequest.agent === "grok"
                ? await restoreGrokSessionBundle({ ...source, cwd: worktree })
                : await restoreClaudeSessionBundle({ ...source, cwd: worktree });
        } catch (error) {
          console.warn(
            JSON.stringify({
              event: "agent_session_restore_failed",
              executionId: job.executionId,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
          reportRestore({
            restored: false,
            reason: error instanceof SessionIntegrityError ? "integrity" : "unpack",
          });
        }
    }
    // A handover stops the agent only when no tool call runs but ask_team calls waiting for a
    // person. A call is ask_team when the agent names it so; any other must finish first.
    const toolCalls = new Map<string, { askTeam: boolean }>();
    let waitingForAnswer = 0;
    const safePoint = () =>
      [...toolCalls.values()].every((call) => call.askTeam && waitingForAnswer > 0);
    const earlierSession =
      command.type === "run"
        ? restoreRequest
          ? restored && restoreRequest.sessionId
          : command.resumeSessionId
        : undefined;
    const agent: RunAgentOptions = {
      ...options.launch,
      hostAccess: true,
      skillsRoot,
      ...(options.skills && (repository || task)
        ? {
            agentSkills: {
              claude: options.skills,
              codex: join(options.skills, RUNNER_SKILL_FOLDERS.codex),
            },
          }
        : {}),
      ...(command.type === "run" && command.hooks?.length ? { workspaceHooks: command.hooks } : {}),
      env: agentEnv,
      ...(installed.binPaths.length ? { runtimeBinPaths: installed.binPaths } : {}),
      closeoutBasePath,
      checkpointEnv: env,
      commitPolicy: command.type === "run" ? command.commitPolicy : undefined,
      ...(command.type === "run" && command.repository.mainSha
        ? { mainSha: command.repository.mainSha }
        : {}),
      ...(command.type === "run" && options.answer
        ? {
            closeoutPolicy: remoteCloseoutPolicy(
              emit,
              options.answer,
              options.signal ?? new AbortController().signal,
            ),
          }
        : {}),
      checkpointIdentity:
        command.type === "run" && command.checkpointBot
          ? appBotCommitIdentity(command.checkpointBot)
          : undefined,
      checkpointExcludePaths: inputFiles.map((file) => file.path),
      profile:
        command.type === "login_check" ? { agent: command.agent, model: null } : command.profile,
      role: command.type === "review" ? "reviewer" : "implementer",
      readOnly: command.type === "task" ? command.purpose !== "artifact" : command.type !== "run",
      checkpoint: command.type === "run" && command.checkpoint !== false,
      prepareOnly: !repository && command.type !== "helper" && !task,
      itemId: repository || task ? command.itemId : job.executionId,
      runId: job.executionId,
      prompt: resumed
        ? RESUME_PROMPT
        : earlierSession
          ? `This continues your earlier session in a fresh checkout at ${worktree}, which holds the latest commit.\n\n${currentRequest(prompt)}`
          : prompt,
      ...(earlierSession && !resumed
        ? { resume: { sessionId: earlierSession, replayPrompt: prompt } }
        : {}),
      ...(resumed
        ? {
            resume: {
              sessionId: resumedId ?? "",
              replayPrompt: reconstructAcpPrompt(RESUME_PROMPT, [
                { kind: "request", body: prompt },
                ...(await recoverAcpConversation(join(options.outputDirectory, "events.jsonl"))),
              ]),
            },
          }
        : {}),
      inputFiles: inputFiles.map((file) => ({ ...file, path: join(worktree, file.path) })),
      worktreePath: worktree,
      pawsRoot: join(task ? worktree : options.workRoot, ".paws"),
      home: options.home,
      signal: options.signal,
      onEvent(event) {
        try {
          if (
            event.type === "session_update" &&
            (event.update.sessionUpdate === "tool_call" ||
              event.update.sessionUpdate === "tool_call_update")
          ) {
            const { status, toolCallId } = event.update;
            if (status === "completed" || status === "failed") toolCalls.delete(toolCallId);
            else if (event.update.sessionUpdate === "tool_call" || status) {
              const named = `${event.update.title ?? ""} ${JSON.stringify(event.update["_meta"] ?? {})}`;
              toolCalls.set(toolCallId, {
                askTeam: toolCalls.get(toolCallId)?.askTeam || named.includes("ask_team"),
              });
            }
          }
          if (restored && restoreRequest && event.type === "session_started")
            reportRestore(
              event.sessionId === restoreRequest.sessionId
                ? { restored: true }
                : { restored: false, reason: "load" },
            );
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
          if (event.type === "session_update" && event.update.sessionUpdate === "usage_update") {
            const limits = claudeLimits(event.update["_meta"]?.["_claude/rateLimit"]);
            if (limits.length) agentLimits = limits;
            tokens = Math.max(tokens, event.update.used ?? 0);
          }
          emit({ type: "acp", event: compactAcpEvent(event) });
          if (event.type === "hook_failed") {
            const parsed = RunnerEventSchema.safeParse(event);
            if (parsed.success && parsed.data.type === "hook_failed") emit(parsed.data);
          }
          if (event.type === "progress" && !event.messageChunk) {
            const parsed = RunnerEventSchema.safeParse({ type: "progress", text: event.text });
            if (
              parsed.success &&
              parsed.data.type === "progress" &&
              updates.take(job.executionId).posted
            )
              emit(parsed.data);
          }
        } catch (error) {
          eventFailure = error instanceof Error ? error : new Error(String(error));
          throw error;
        }
      },
      publishArtifact: (task ? command.purpose === "artifact" : repository)
        ? {
            async publish(snapshot, context) {
              if (!options.answer) throw new Error("Runner artifact publication is unavailable");
              if (artifactsPublished >= RUNNER_ARTIFACT_COUNT_LIMIT)
                throw new ArtifactRejectedError(
                  `publish_artifact allows ${RUNNER_ARTIFACT_COUNT_LIMIT} artifacts per run and this run has used all ${RUNNER_ARTIFACT_COUNT_LIMIT}; 0 slots are left. ${snapshot.path} was not published. Link the artifacts you already published instead.`,
                );
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
                ...(context.evidence ? { evidence: context.evidence } : {}),
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
              artifactsPublished++;
              const reply = await options.answer(artifact.id, context.signal);
              context.signal.throwIfAborted();
              const publication = JSON.parse(reply.answer) as {
                url?: unknown;
                error?: unknown;
                note?: unknown;
              };
              if (typeof publication.error === "string")
                throw new ArtifactRejectedError(publication.error);
              if (typeof publication.url !== "string")
                throw new Error("Runner artifact publication response is invalid");
              const slots = `${RUNNER_ARTIFACT_COUNT_LIMIT - artifactsPublished} of ${RUNNER_ARTIFACT_COUNT_LIMIT} artifact slots are left in this run.`;
              return {
                url: publication.url,
                note: typeof publication.note === "string" ? `${publication.note} ${slots}` : slots,
              };
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
      closeoutProgress:
        command.type === "run"
          ? {
              record(progress) {
                if (journalSize > 8_388_608) return;
                const parsed = RunnerEventSchema.safeParse({ type: "closeout", progress });
                if (parsed.success && parsed.data.type === "closeout") emit(parsed.data);
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
      postUpdate:
        command.type === "run" || command.type === "task"
          ? {
              async post(text) {
                const parsed = RunnerEventSchema.safeParse({ type: "progress", text });
                if (!parsed.success || parsed.data.type !== "progress")
                  throw new Error("post_update needs text of 1 to 500 characters");
                const allowed = updates.take(job.executionId);
                if (allowed.posted) emit(parsed.data);
                return allowed;
              },
            }
          : undefined,
      askTeam:
        command.type === "helper"
          ? undefined
          : {
              async ask(request, context) {
                if (!options.answer) throw new Error("Runner question channel is unavailable");
                if (request.context && request.context.length > 16_384)
                  throw new Error(
                    "ask_team context must be at most 16384 characters. Shorten it and ask again.",
                  );
                const requestId = randomUUID();
                emit({
                  type: "question",
                  requestId,
                  question: request.question,
                  ...(request.context ? { context: request.context } : {}),
                  options: request.options ?? [],
                });
                waitingForAnswer++;
                try {
                  return await options.answer(requestId, context.signal);
                } finally {
                  waitingForAnswer--;
                }
              },
            },
    };
    const runner =
      command.type === "run"
        ? (input: RunAgentOptions) =>
            runWithShellRecovery(input, {
              notice: (text) => emit({ type: "progress", text, notice: true }),
              log: (detection) =>
                console.warn(
                  JSON.stringify({
                    event: "agent_shell_broken",
                    executionId: job.executionId,
                    ...detection,
                  }),
                ),
            })
        : command.type === "review" && command.reviewCommand
          ? async (input: RunAgentOptions): Promise<RunAgentResult> => {
              const base = command.reviewCommand!.base;
              const known = await invokeGit([
                "-C",
                worktree,
                "cat-file",
                "-e",
                `${base}^{commit}`,
              ]).then(
                () => true,
                (caughtError) => {
                  journalCaught(caughtError, "runner-worker.reviewCommand.base", command.itemId);
                  return false;
                },
              );
              if (!known)
                return {
                  role: "reviewer",
                  stopReason: "error",
                  errorMessage: `The review base ${base} is not in the run's checkout`,
                  timedOut: false,
                  cancelled: false,
                  authRequired: false,
                  agentExited: true,
                };
              const agentName = command.profile.agent === "codex" ? "codex" : "claude";
              emit({
                type: "progress",
                text:
                  agentName === "codex"
                    ? `Running codex exec review --base ${base.slice(0, 7)}.`
                    : `Running Claude /code-review ${base.slice(0, 7)}..${command.repository.baseSha.slice(0, 7)}.`,
              });
              return reviewCommandTurn({
                agent: agentName,
                model: command.profile.model!,
                base,
                head: command.repository.baseSha,
                worktree,
                executable: providerCli(agentName),
                env: input.env ?? agentEnv,
                timeoutMs: Math.max(1, command.expiresAt - Date.now()),
                ...(input.signal ? { signal: input.signal } : {}),
                onText: (text) => {
                  reviewText = text;
                },
              });
            }
          : runAgent;
    const runCommand = command.type === "run" ? command : undefined;
    const stepTimeout = options.handoverStepTimeoutMs ?? HANDOVER_STEP_TIMEOUT_MS;
    /** A step after the interrupt, cut off after its own timeout rather than the deadline. */
    const bounded = async <T>(step: string, work: (signal: AbortSignal) => Promise<T>) => {
      const timeout = AbortSignal.timeout(stepTimeout);
      const signal = AbortSignal.any([timeout, ...(options.signal ? [options.signal] : [])]);
      return await Promise.race([
        work(signal),
        new Promise<never>((_, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new Error(`The handover ${step} took longer than ${stepTimeout} ms`)),
            { once: true },
          ),
        ),
      ]);
    };
    /**
     * Waits for the next handover Paws asks for, then for a safe point until that request's
     * deadline, and interrupts the turn. Returns true once it interrupted, or false when the turn
     * ended first. A request with no safe point in time is reported, the session keeps running,
     * and the watch goes on with the next request.
     */
    const watchHandover = (interrupt: AbortController, watch: AbortSignal) =>
      (async (): Promise<boolean> => {
        for (let sequence = 1; ; sequence++) {
          const { deadline } = await options.handover!(sequence, watch);
          while (!safePoint() && Date.now() < deadline)
            await delay(50, undefined, { signal: watch });
          if (safePoint() && Date.now() < deadline) {
            // The same interrupt a follow-up uses: the agent stops, its session stays intact.
            interrupt.abort(FOLLOW_UP_INTERRUPTION);
            return true;
          }
          console.warn(
            JSON.stringify({ event: "handover_timed_out", executionId: job.executionId }),
          );
          emit({ type: "handover", handedOver: false, reason: "timeout" });
        }
      })().catch((error: unknown) => {
        if (!watch.aborted)
          journalCaught(error, "runner-worker.executeRunnerCommand.handover", runCommand!.itemId);
        return false;
      });
    /**
     * The interrupted turn's WIP commit and its session snapshot. Both always run once the agent
     * stopped; a step that fails or runs out of time names the failure.
     */
    const prepareHandover = async (turn: RunAgentResult): Promise<RunnerHandoverFailure | null> => {
      try {
        await bounded("commit", (signal) =>
          commitCheckpoint(
            worktree,
            runCommand!.commitPolicy
              ? commitPolicyMessage(HANDOVER_COMMIT_MESSAGE, runCommand!.commitPolicy)
              : HANDOVER_COMMIT_MESSAGE,
            signal,
            undefined,
            env,
            inputFiles.map((file) => file.path),
            runCommand!.commitPolicy
              ? appBotCommitIdentity(runCommand!.commitPolicy.bot)
              : runCommand!.checkpointBot
                ? appBotCommitIdentity(runCommand!.checkpointBot)
                : undefined,
          ),
        );
      } catch (error) {
        journalCaught(
          error,
          "runner-worker.executeRunnerCommand.handoverCommit",
          runCommand!.itemId,
        );
        return "commit";
      }
      for (const name of [SESSION_METADATA_FILE, SESSION_BUNDLE_FILE])
        rmSync(join(options.outputDirectory, name), { force: true });
      const sessionAgent = runCommand!.profile.agent;
      try {
        if (!turn.sessionId) throw new Error("The agent reported no session to save");
        const sessionId = turn.sessionId;
        await bounded("snapshot", async () =>
          snapshotAgentSession(
            options,
            job.executionId,
            sessionAgent,
            {
              sessionId,
              workspacePath: worktree,
              commitSha: (await invokeGit(["-C", worktree, "rev-parse", "HEAD"])).trim(),
              turn: runCommand!.generation,
            },
            emit,
          ),
        );
        if (!existsSync(join(options.outputDirectory, SESSION_METADATA_FILE)))
          throw new Error("The agent session snapshot was not written");
        return null;
      } catch (error) {
        journalCaught(
          error,
          "runner-worker.executeRunnerCommand.handoverSnapshot",
          runCommand!.itemId,
        );
        for (const name of [SESSION_METADATA_FILE, SESSION_BUNDLE_FILE])
          rmSync(join(options.outputDirectory, name), { force: true });
        return "snapshot";
      }
    };
    /** The worktree state this turn last emitted, and the commit it emitted for it. */
    let checkpointed: string | undefined;
    let checkpointedSha: string | undefined;
    const published = new Set<string>();
    let acknowledged = 0;
    /** Whether the runner pushed `sha`; an unpublished checkpoint is tried again. */
    const wasPublished = (sha: string | undefined) => {
      if (!options.checkpointPublished) return true;
      for (let pushed = options.checkpointPublished(acknowledged + 1); pushed;) {
        published.add(pushed);
        acknowledged++;
        pushed = options.checkpointPublished(acknowledged + 1);
      }
      return sha !== undefined && published.has(sha);
    };
    let checkpointing = Promise.resolve();
    /**
     * Publishes the worktree as a WIP commit on top of the branch, uncommitted changes included,
     * without touching the agent's branch, index or files. The runtime pushes the bundle to the
     * item's branch. An unchanged worktree publishes nothing; a stop Paws asked for still hears.
     */
    const checkpointWorktree = async (reason: "stop" | "interval") => {
      const run = runCommand!;
      try {
        const snapshot = (always: boolean) =>
          snapshotWorktree(
            worktree,
            run.commitPolicy
              ? commitPolicyMessage(CHECKPOINT_COMMIT_MESSAGE, run.commitPolicy)
              : CHECKPOINT_COMMIT_MESSAGE,
            env,
            inputFiles.map((file) => file.path),
            run.commitPolicy
              ? appBotCommitIdentity(run.commitPolicy.bot)
              : run.checkpointBot
                ? appBotCommitIdentity(run.checkpointBot)
                : undefined,
            always,
          );
        let saved = await snapshot(false);
        const key = `${saved.head}:${saved.tree}`;
        // Only an interval skips what this turn already emitted: its push may have failed, so a
        // stop always publishes the worktree as it is.
        if (reason === "interval" && key === checkpointed && wasPublished(checkpointedSha)) return;
        if (saved.sha === run.repository.baseSha) {
          // The base is already the item's checkpoint, unless this turn saved work since.
          if (checkpointed === undefined) {
            if (reason === "stop") emit({ type: "checkpoint", reason });
            return;
          }
          // A worktree back at the base replaces the earlier checkpoint with a WIP commit of it,
          // so a restart does not bring back what the agent discarded.
          saved = await snapshot(true);
        }
        const name = `checkpoint-${saved.sha}.bundle` as const;
        const path = join(options.outputDirectory, name);
        const ref = `refs/paws/checkpoint-${randomUUID()}`;
        // A stop that republishes an unchanged clean head reuses its bundle.
        if (!existsSync(path)) {
          await invokeGit(["-C", worktree, "update-ref", ref, saved.sha]);
          try {
            closeSync(outputFile(options.outputDirectory, name, options.resultsGid));
            const bases = [
              run.repository.baseSha,
              ...(run.repository.mainSha ? [run.repository.mainSha] : []),
            ];
            await invokeGit([
              "-C",
              worktree,
              "bundle",
              "create",
              path,
              ref,
              ...bases.map((base) => `^${base}`),
            ]);
            const bundle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
              const info = fstatSync(bundle);
              if (!info.isFile() || info.size > 536_870_912)
                throw new Error("Runner checkpoint exceeds size limit");
              fchownSync(bundle, process.getuid!(), options.resultsGid);
              fchmodSync(bundle, 0o640);
              fsyncSync(bundle);
            } finally {
              closeSync(bundle);
            }
          } catch (error) {
            rmSync(path, { force: true });
            throw error;
          } finally {
            await invokeGit(["-C", worktree, "update-ref", "-d", ref]);
          }
        }
        checkpointed = key;
        checkpointedSha = saved.sha;
        emit({ type: "checkpoint", reason, sha: saved.sha });
      } catch (error) {
        journalCaught(error, "runner-worker.executeRunnerCommand.checkpoint", run.itemId);
        if (reason === "stop") emit({ type: "checkpoint", reason });
      }
    };
    const checkpoint = (reason: "stop" | "interval") =>
      (checkpointing = checkpointing.then(() => checkpointWorktree(reason)));
    /**
     * The interval checkpoints, taken while the agent works, and the ones Paws asks for before it
     * stops the run. A stop halts the agent first and snapshots once its turn ended, so nothing it
     * does while the commit is published can miss the checkpoint.
     */
    const watchCheckpoints = (watch: AbortSignal, halt: AbortController, turnDone: Promise<void>) =>
      Promise.allSettled([
        (async () => {
          for (;;) {
            await delay(options.checkpointIntervalMs ?? CHECKPOINT_INTERVAL_MS, undefined, {
              signal: watch,
            });
            await checkpoint("interval");
          }
        })(),
        (async () => {
          if (!options.checkpoint) return;
          await options.checkpoint(1, watch);
          // The same interrupt a follow-up uses: the agent stops, its session stays intact.
          halt.abort(FOLLOW_UP_INTERRUPTION);
          await turnDone;
          await checkpoint("stop");
        })(),
      ]);
    const interrupt = new AbortController();
    const watch = new AbortController();
    const handover =
      runCommand && options.handover && installFailure === undefined
        ? watchHandover(interrupt, watch.signal)
        : undefined;
    const halt = new AbortController();
    let endTurn!: () => void;
    const turnDone = new Promise<void>((resolve) => (endTurn = resolve));
    const checkpoints =
      runCommand && runCommand.checkpoint !== false && installFailure === undefined
        ? watchCheckpoints(watch.signal, halt, turnDone)
        : undefined;
    const current: RunAgentOptions =
      handover || checkpoints
        ? {
            ...agent,
            signal: AbortSignal.any([
              ...(handover ? [interrupt.signal] : []),
              ...(checkpoints ? [halt.signal] : []),
              ...(options.signal ? [options.signal] : []),
            ]),
          }
        : agent;
    let run: RunAgentResult =
      installFailure !== undefined
        ? {
            role: agent.role,
            stopReason: "error",
            errorMessage: installFailure,
            cancelled: false,
            timedOut: false,
            authRequired: false,
            agentExited: false,
          }
        : runCommand && options.followUp
          ? await runWithFollowUps(current, options.followUp, runner).finally(endTurn)
          : await runner(current).finally(endTurn);
    endTurn();
    // A turn halted for a stop leaves its work in the stop checkpoint, never in a candidate.
    if (halt.signal.aborted) run = { ...run, cancelled: true, interrupted: false };
    watch.abort();
    const interrupted = (await handover) === true;
    // A checkpoint in progress finishes before the turn's own commit and result.
    await checkpoints;
    await checkpointing;
    let handoverReady = false;
    let handoverFailure: RunnerHandoverFailure | null = null;
    if (interrupted && (!run.cancelled || !run.agentExited || options.signal?.aborted))
      console.warn(JSON.stringify({ event: "handover_skipped", executionId: job.executionId }));
    else if (interrupted) {
      emit({ type: "handover_interrupted" });
      handoverFailure = await prepareHandover(run);
      handoverReady = handoverFailure === null;
    }
    // A failed handover ends the run here as an interrupted turn: its session stays on this
    // runner, and Paws resumes it there with session/load.
    const failHandover = (failure: RunnerHandoverFailure) => {
      handoverFailure = failure;
      run = { ...run, cancelled: false, interrupted: true, handoverFailure: failure };
    };
    if (handoverFailure) failHandover(handoverFailure);
    // The agent never opened a session, so the restored one did not load either.
    if (restored) reportRestore({ restored: false, reason: "load" });
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
              executable: providerCli(command.agent),
              env: agentEnv,
              run: options.loginCommand,
            });
      const authenticated =
        run.stopReason === "end_turn" &&
        !run.authRequired &&
        !run.errorMessage &&
        (checked?.loggedIn ?? Boolean(run.identity));
      if (authenticated && command.agent === "codex")
        agentLimits = codexLimits(
          await (options.codexRateLimits ?? readCodexRateLimits)(
            agentEnv,
            providerCli("codex"),
          ).catch((caughtError2) => {
            journalCaught(caughtError2, "runner-worker.executeRunnerCommand.providerCli", null);
            return null;
          }),
        );
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
    if (agentLimits.length) result.run = { ...result.run, agentLimits };
    if (tokens > 0) result.run = { ...result.run, tokens };
    const clean = run.stopReason === "end_turn" && !run.errorMessage;
    const wip = !clean && command.type === "run" && !run.cancelled;
    const recordCandidate = async () => {
      if (command.type !== "run" && command.type !== "review") return;
      const sha = (await invokeGit(["-C", worktree, "rev-parse", "HEAD"])).trim();
      if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid runner candidate commit");
      const bases = await candidateBases(
        (args) => invokeGit(["-C", worktree, ...args]),
        command.repository.baseSha,
      );
      if (command.repository.mainSha) bases.push(command.repository.mainSha);
      await assertDescendsFromAny((args) => invokeGit(["-C", worktree, ...args]), bases, sha);
      if (command.type === "run") {
        if (command.commitPolicy)
          await validateCandidateAttribution(
            worktree,
            bases,
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
            ...bases.filter((base) => base !== sha).map((base) => `^${base}`),
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
    };
    if (repository && run.agentExited && clean) await recordCandidate();
    else if (repository && run.agentExited && wip) {
      await recordCandidate().catch((caughtError3) => {
        journalCaught(
          caughtError3,
          "runner-worker.executeRunnerCommand.recordCandidate",
          command.itemId,
        );
        delete result.candidateSha;
      });
      if (command.type === "run" && result.candidateSha === command.repository.baseSha)
        delete result.candidateSha;
    } else if (command.type === "run" && handoverReady) {
      // The WIP commit is published like a candidate; the next runner starts from it.
      try {
        await bounded("publication", () => recordCandidate());
        if (result.candidateSha === command.repository.baseSha) delete result.candidateSha;
        result.run = { ...result.run, cancelled: false, interrupted: false, handedOver: true };
        emit({ type: "handover", handedOver: true });
      } catch (error) {
        journalCaught(
          error,
          "runner-worker.executeRunnerCommand.handoverPublication",
          command.itemId,
        );
        delete result.candidateSha;
        failHandover("publication");
        result.run = { ...result.run, ...run };
      }
    }
    if (command.type === "run" && handoverFailure) {
      console.warn(
        JSON.stringify({
          event: "handover_failed",
          executionId: job.executionId,
          reason: handoverFailure,
        }),
      );
      emit({ type: "handover", handedOver: false, reason: handoverFailure });
    }
    const handedOver = result.run.handedOver === true;
    // A turn that ended, not a cancel or a crash, leaves a session another runner can load. An
    // earlier attempt's bundle never stands in for this one; a handover already took its own.
    if (command.type === "run" && !handedOver)
      for (const name of [SESSION_METADATA_FILE, SESSION_BUNDLE_FILE])
        rmSync(join(options.outputDirectory, name), { force: true });
    if (
      command.type === "run" &&
      !handedOver &&
      installFailure === undefined &&
      run.agentExited &&
      !run.cancelled &&
      run.stopReason !== "cancelled" &&
      run.stopReason !== "error" &&
      run.sessionId &&
      !options.signal?.aborted
    )
      await snapshotAgentSession(
        options,
        job.executionId,
        command.profile.agent,
        {
          sessionId: run.sessionId,
          workspacePath: worktree,
          commitSha: result.candidateSha ?? command.repository.baseSha,
          turn: command.generation,
        },
        emit,
      );
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
    closeSync(eventJournal);
  }
}

/**
 * Install the command's runtimes with mise before the agent starts. Returns the one line
 * that fails the task when an install fails or runs past its cap, and otherwise each
 * runtime's pinned bin dir for the agent's and Closeout's `PATH`.
 * The install time goes to the runner's log; the start line in Linear names the runtimes.
 */
async function installCommandRuntimes(
  command: RunnerJob["command"],
  executionId: string,
  options: RunnerWorkerOptions,
  emit: (event: RunnerWorkerEvent) => void,
): Promise<{ failure?: string; binPaths: string[] }> {
  const runtimes =
    command.type === "run" || command.type === "review" || command.type === "task"
      ? (command.runtimes ?? [])
      : [];
  if (!runtimes.length) return { binPaths: [] };
  const result = await installRuntimes({
    runtimes,
    home: options.home,
    ...(options.mise?.path ? { mise: options.mise.path } : {}),
    ...(options.mise?.timeoutMs !== undefined ? { timeoutMs: options.mise.timeoutMs } : {}),
    signal: options.signal,
    notice: (text) => emit({ type: "progress", text, notice: true }),
  });
  const labels = runtimes.map((runtime) => `${runtime.tool}@${runtime.version}`);
  console.warn(
    JSON.stringify({
      event: "runtime_install",
      executionId,
      runtimes: labels,
      durationMs: result.durationMs,
      ok: result.ok,
      ...(result.ok
        ? {}
        : {
            runtime: `${result.runtime.tool}@${result.runtime.version}`,
            message: result.message,
          }),
    }),
  );
  // Installs run in order and stop at the first failure, so the ones before it are installed.
  const report: RunnerInstalledRuntime[] = result.ok
    ? runtimes.map((runtime) => ({ ...runtime, status: "installed" }))
    : [
        ...runtimes
          .slice(
            0,
            Math.max(
              0,
              runtimes.findIndex(
                (runtime) =>
                  runtime.tool === result.runtime.tool &&
                  runtime.version === result.runtime.version,
              ),
            ),
          )
          .map((runtime) => ({ ...runtime, status: "installed" as const })),
        { ...result.runtime, status: "failed", error: result.message.slice(0, 500) },
      ];
  try {
    replaceOutputFile(options, "runtimes.json", JSON.stringify(report));
  } catch (error) {
    journalCaught(
      error,
      "runner-worker.installCommandRuntimes.replaceOutputFile",
      "itemId" in command ? command.itemId : null,
    );
  }
  if (!result.ok) return { failure: result.message.slice(0, 500), binPaths: [] };
  // Paws names the runtimes in its start line, so a successful install posts nothing more.
  return { binPaths: result.binPaths };
}

export async function runRunnerWorker(options: {
  executionId: string;
  spool: RunnerSpool;
  results: RunnerResults;
  workRoot: string;
  home: string;
  signal?: AbortSignal;
  resume?: boolean;
  skills?: string;
}): Promise<RunnerWorkerResult> {
  if (process.getuid?.() === 0 || process.getuid?.() !== options.results.agentUid)
    throw new Error("Runner worker identity is invalid");
  const spool = options.spool;
  const job = readRunnerJob(spool, options.executionId);
  return executeRunnerCommand({
    job,
    inputs: readRunnerJobInputs(spool, options.executionId),
    ...(job.command.type === "run" || job.command.type === "review"
      ? {
          repositoryBundle: runnerRepositoryBundlePath(spool, options.executionId),
          sessionBundle: runnerSessionBundlePath(spool, options.executionId),
        }
      : job.command.type === "task" && job.command.repository
        ? { repositorySnapshot: runnerTaskRepositoryPath(spool, options.executionId) }
        : {}),
    outputDirectory: runnerResultDirectory(options.results, options.executionId),
    workRoot: job.command.type === "task" ? "/var/lib/paws-agent-tasks" : options.workRoot,
    home: options.home,
    resultsGid: options.results.resultsGid,
    signal: options.signal,
    resume: options.resume,
    ...(options.skills ? { skills: options.skills } : {}),
    async answer(requestId, signal) {
      while (true) {
        signal.throwIfAborted();
        const answer = readRunnerAnswer(spool, options.executionId, requestId);
        if (answer) return { answer: answer.answer };
        await delay(250, undefined, { signal });
      }
    },
    ...(job.command.type === "run"
      ? {
          async handover(sequence: number, signal: AbortSignal) {
            const requestId = runnerHandoverRequestId(sequence);
            for (;;) {
              const request = readRunnerAnswer(spool, options.executionId, requestId);
              if (request) return { deadline: Number(request.answer) };
              await delay(250, undefined, { signal });
            }
          },
          checkpointPublished(sequence: number) {
            return (
              readRunnerAnswer(spool, options.executionId, runnerCheckpointPublishedId(sequence))
                ?.answer ?? null
            );
          },
          async checkpoint(sequence: number, signal: AbortSignal) {
            const requestId = runnerCheckpointRequestId(sequence);
            while (!readRunnerAnswer(spool, options.executionId, requestId))
              await delay(250, undefined, { signal });
          },
        }
      : {}),
    async followUp(sequence, signal) {
      while (true) {
        signal.throwIfAborted();
        const message = readRunnerAnswer(
          spool,
          options.executionId,
          runnerFollowUpRequestId(sequence),
        );
        if (message) return message.answer;
        await delay(250, undefined, { signal });
      }
    },
  });
}
