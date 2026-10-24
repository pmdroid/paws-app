import { runProviderLogin } from "../runner-login-worker";
import type { RunnerLoginUpdate } from "../runner-protocol";
import { checkoutPatterns, exclusionPatterns } from "../worktree-checkout";
import {
  closeSync,
  chmodSync,
  cpSync,
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
  existsSync,
} from "node:fs";
import { join, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  appBotCommitIdentity,
  ASK_TEAM_TOOL_NAME,
  commitCheckpoint,
  commitPolicyMessage,
  createUpdateLimiter,
  validateCandidateAttribution,
  assertDescendsFromAny,
  ArtifactRejectedError,
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
  type PolicyFilesLoad,
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
import { readRunnerAnswer, readRunnerHandover, runnerFollowUpRequestId } from "../runner-answers";
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
  RunnerArtifactSchema,
  RunnerEventSchema,
  RunnerHelperResultSchema,
  type RunnerArtifact,
  type RunnerEvent,
} from "../runner-protocol";

import { compactAcpEvent } from "./compact";

export { compactAcpEvent };

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
  followUp?: (sequence: number, signal: AbortSignal) => Promise<string>;
  /** Resolves when the runner asks for handover request `sequence`, with its deadline. */
  handover?: (sequence: number, signal: AbortSignal) => Promise<{ expiresAt: number }>;
  now?: () => number;
  loginCommand?: LoginCommandRunner;
  codexRateLimits?: CodexRateLimitReader;
  resume?: boolean;
}

/** Of the handover time, this much is kept for the WIP commit, the push and the transcript. */
export const HANDOVER_PUBLISH_RESERVE_MS = 30_000;
export const HANDOVER_COMMIT_MESSAGE = "wip: handover checkpoint";
export const HANDOVER_TIMEOUT_NOTICE =
  "Paws asked this runner to hand over the session, but the agent's current tool call did not finish in time. The session stays on this runner.";

export const HANDOVER_RESUME_PROMPT =
  "Paws tried to move this session to another runner, but the handover did not finish in time. The session stays on this runner. Your work so far is in a WIP commit. Check git status and the workspace, then continue where you left off.";
/** A handed-over result waits here until the runner publishes it before its deadline. */
export const HANDOVER_RESULT = "handover.json";

/** The host tool server the agent reaches ask_team through. */
const HOST_TOOL_SERVER = "paws";

/**
 * Whether a tool call is the agent's own ask_team call, by the tool identity the ACP adapter
 * reports, never by the call's arguments: an edit whose text mentions ask_team is still an edit.
 * Claude names the tool in `_meta.claudeCode.toolName`; Codex titles it `mcp.<server>.<tool>`
 * and reports `server` and `tool` in its input.
 */
export function isAskTeamCall(update: {
  title?: string | null;
  rawInput?: unknown;
  _meta?: { [key: string]: unknown } | null;
}): boolean {
  const claude = update["_meta"]?.["claudeCode"] as { toolName?: unknown } | undefined;
  const input = update.rawInput as { server?: unknown; tool?: unknown } | null | undefined;
  return (
    claude?.toolName === `mcp__${HOST_TOOL_SERVER}__${ASK_TEAM_TOOL_NAME}` ||
    update.title === `mcp__${HOST_TOOL_SERVER}__${ASK_TEAM_TOOL_NAME}` ||
    update.title === `mcp.${HOST_TOOL_SERVER}.${ASK_TEAM_TOOL_NAME}` ||
    (typeof input === "object" &&
      input !== null &&
      input.server === HOST_TOOL_SERVER &&
      input.tool === ASK_TEAM_TOOL_NAME)
  );
}

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
      () => null,
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
  emit: (event: { type: "closeout_policy"; requestId: string }) => void,
  answer: (requestId: string, signal: AbortSignal) => Promise<{ answer: string }>,
  signal: AbortSignal,
): () => Promise<PolicyFilesLoad> {
  return async () => {
    const requestId = randomUUID();
    try {
      emit({ type: "closeout_policy", requestId });
      return decodePolicyFiles((await answer(requestId, signal)).answer);
    } catch (error) {
      signal.throwIfAborted();
      return {
        ok: false,
        message: `Paws could not provide the Closeout policy: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}

export type RunnerWorkerEvent =
  | { type: "login"; update: RunnerLoginUpdate }
  | { type: "closeout_policy"; requestId: string }
  | { type: "acp"; event: AcpEvent }
  | { type: "question"; requestId: string; question: string; options: readonly unknown[] }
  | { type: "artifact"; requestId: string; artifact: RunnerArtifact }
  | Extract<
      RunnerEvent,
      { type: "plan" | "pull_request" | "progress" | "closeout" | "hook_failed" }
    >;

export interface RunnerWorkerResult {
  executionId: string;
  commandId: string;
  run: RunAgentResult & { agentLimits?: AgentLimit[] };
  candidateSha?: string;
  /** When a handed-over result must be published by, or the session continues on the runner. */
  handoverExpiresAt?: number;
  /** The handover request this result answers; a restarted worker does not act on it again. */
  handoverSequence?: number;
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

function resumedSession(directory: string): string | undefined {
  let sessionId: string | undefined;
  for (const line of readFileSync(join(directory, "events.jsonl"), "utf8").split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; event?: AcpEvent };
      if (entry.type === "acp" && entry.event?.type === "session_started")
        sessionId = entry.event.sessionId;
    } catch {}
  }
  return sessionId;
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
  for (const provider of [".codex", ".claude", ".grok"]) {
    mkdirSync(join(options.home, provider), { recursive: true, mode: 0o700 });
    chmodSync(join(options.home, provider), 0o700);
  }
  options.signal?.throwIfAborted();
  for (const [name, kind] of [
    ...(options.resume
      ? []
      : [["events.jsonl", "journal"] as const, [HANDOVER_RESULT, "handover"] as const]),
    ["result.json", "result"] as const,
  ]) {
    try {
      lstatSync(join(options.outputDirectory, name));
      throw new Error(`Runner ${kind} already exists`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const resumed = options.resume === true;
  const resumedId = resumed ? resumedSession(options.outputDirectory) : undefined;
  // The runner restarts a worker whose handover it could not publish in time.
  const handoverResumed = resumed && existsSync(join(options.outputDirectory, HANDOVER_RESULT));
  // The request the missed handover answered stays in the spool; the watcher starts after it.
  let consumedHandover = 0;
  if (handoverResumed) {
    try {
      const missed = JSON.parse(
        readFileSync(join(options.outputDirectory, HANDOVER_RESULT), "utf8"),
      ) as { handoverSequence?: unknown };
      if (Number.isSafeInteger(missed.handoverSequence))
        consumedHandover = missed.handoverSequence as number;
    } catch {}
    rmSync(join(options.outputDirectory, HANDOVER_RESULT), { force: true });
  }
  const resumePrompt = handoverResumed ? HANDOVER_RESUME_PROMPT : RESUME_PROMPT;
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
          }
          const info = lstatSync(parent);
          if (!info.isDirectory() || info.isSymbolicLink())
            throw new Error("Unsafe runner input workspace");
        }
        writeFileSync(join(worktree, file.path), file.bytes, { flag: "wx", mode: 0o600 });
      }
    }
    let reviewText = "";
    let agentLimits: AgentLimit[] = [];
    let tokens = 0;
    let eventFailure: Error | undefined;
    const agentEnv = minimalAgentEnv({
      PATH: "/opt/paws-runner/bin:/usr/local/bin:/usr/bin:/bin",
      ...options.launch?.env,
      HOME: options.home,
      CODEX_HOME: join(options.home, ".codex"),
      CLAUDE_CONFIG_DIR: join(options.home, ".claude"),
    });
    const prompt =
      repository || task || command.type === "helper"
        ? (options.inputs?.prompt ?? command.prompt)
        : "Check agent connection.";
    if (handoverResumed) emit({ type: "progress", text: HANDOVER_TIMEOUT_NOTICE, notice: true });
    else if (resumed) emit({ type: "progress", text: "The agent restarted after a crash." });
    const earlierSession = command.type === "run" ? command.resumeSessionId : undefined;
    // A handover stops the agent between tool calls, or while it waits on ask_team, and
    // publishes the worktree as a WIP commit. A handover that cannot reach that point in time
    // is reported and the session keeps running here.
    const handover =
      command.type === "run" && command.checkpoint !== false && options.handover
        ? {
            requested: options.handover,
            interrupt: new AbortController(),
            watching: new AbortController(),
            /** Active tool calls, and whether each is the agent's ask_team call. */
            tools: new Map<string, boolean>(),
            asking: 0,
            expiresAt: 0,
            sequence: 0,
          }
        : undefined;
    const clock = options.now ?? Date.now;
    async function watchHandover(state: NonNullable<typeof handover>): Promise<void> {
      for (let sequence = consumedHandover + 1; ; sequence++) {
        const request = await state.requested(sequence, state.watching.signal);
        // A request from before a worker restart may already be over.
        if (request.expiresAt <= clock()) continue;
        const safeBy = request.expiresAt - HANDOVER_PUBLISH_RESERVE_MS;
        // A pending question is a safe point only when no other tool call is active, such as
        // an edit that runs next to the question.
        const busy = () =>
          [...state.tools.values()].some((askTeam) => !askTeam || state.asking === 0);
        while (busy() && clock() < safeBy)
          await delay(25, undefined, { signal: state.watching.signal });
        if (busy()) {
          emit({ type: "progress", text: HANDOVER_TIMEOUT_NOTICE, notice: true });
          continue;
        }
        state.expiresAt = request.expiresAt;
        state.sequence = sequence;
        state.interrupt.abort();
        return;
      }
    }
    const agentSignal = handover
      ? options.signal
        ? AbortSignal.any([options.signal, handover.interrupt.signal])
        : handover.interrupt.signal
      : options.signal;
    const agent: RunAgentOptions = {
      ...options.launch,
      hostAccess: true,
      skillsRoot,
      ...(command.type === "run" && command.hooks?.length ? { workspaceHooks: command.hooks } : {}),
      env: agentEnv,
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
      readOnly: command.type === "task" ? command.purpose === "answer" : command.type !== "run",
      checkpoint: command.type === "run" && command.checkpoint !== false,
      prepareOnly: !repository && command.type !== "helper" && !task,
      itemId: repository || task ? command.itemId : job.executionId,
      runId: job.executionId,
      prompt: resumed
        ? resumePrompt
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
              replayPrompt: reconstructAcpPrompt(resumePrompt, [
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
      signal: agentSignal,
      onEvent(event) {
        try {
          if (handover && event.type === "session_update") {
            const update = event.update;
            if (
              update.sessionUpdate === "tool_call" ||
              update.sessionUpdate === "tool_call_update"
            ) {
              if (update.status === "completed" || update.status === "failed")
                handover.tools.delete(update.toolCallId);
              else if (
                update.sessionUpdate === "tool_call" ||
                handover.tools.has(update.toolCallId)
              )
                handover.tools.set(
                  update.toolCallId,
                  (handover.tools.get(update.toolCallId) ?? false) || isAskTeamCall(update),
                );
            }
          }
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
              return {
                url: publication.url,
                ...(typeof publication.note === "string" ? { note: publication.note } : {}),
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
                const requestId = randomUUID();
                emit({
                  type: "question",
                  requestId,
                  question: request.question,
                  options: request.options ?? [],
                });
                // Paws holds the question once the event is out, so the wait is a safe point.
                if (handover) handover.asking++;
                try {
                  return await options.answer(requestId, context.signal);
                } finally {
                  if (handover) handover.asking--;
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
        : runAgent;
    const watcher = handover
      ? watchHandover(handover).catch((error: unknown) => {
          if (!handover.watching.signal.aborted) throw error;
        })
      : undefined;
    let run: RunAgentResult;
    try {
      run =
        command.type === "run" && options.followUp
          ? await runWithFollowUps(agent, options.followUp, runner)
          : await runner(agent);
    } finally {
      handover?.watching.abort();
    }
    await watcher;
    const handedOver =
      handover !== undefined &&
      handover.interrupt.signal.aborted &&
      !options.signal?.aborted &&
      run.cancelled &&
      run.agentExited;
    if (handedOver) run = { ...run, handedOver: true };
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
      if (authenticated && command.agent === "codex")
        agentLimits = codexLimits(
          await (options.codexRateLimits ?? readCodexRateLimits)(agentEnv).catch(() => null),
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
      const bases = [command.repository.baseSha];
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
    if (handedOver && command.type === "run") {
      await commitCheckpoint(
        worktree,
        command.commitPolicy
          ? commitPolicyMessage(HANDOVER_COMMIT_MESSAGE, command.commitPolicy)
          : HANDOVER_COMMIT_MESSAGE,
        options.signal,
        undefined,
        env,
        inputFiles.map((file) => file.path),
        command.commitPolicy
          ? appBotCommitIdentity(command.commitPolicy.bot)
          : command.checkpointBot
            ? appBotCommitIdentity(command.checkpointBot)
            : undefined,
      );
      await recordCandidate();
      if (result.candidateSha === command.repository.baseSha) delete result.candidateSha;
      result.handoverExpiresAt = handover!.expiresAt;
      result.handoverSequence = handover!.sequence;
    } else if (repository && run.agentExited && clean) await recordCandidate();
    else if (repository && run.agentExited && wip) {
      await recordCandidate().catch(() => {
        delete result.candidateSha;
      });
      if (command.type === "run" && result.candidateSha === command.repository.baseSha)
        delete result.candidateSha;
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
      renameSync(
        stagingPath,
        join(options.outputDirectory, handedOver ? HANDOVER_RESULT : "result.json"),
      );
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

export async function runRunnerWorker(options: {
  executionId: string;
  spool: RunnerSpool;
  results: RunnerResults;
  workRoot: string;
  home: string;
  signal?: AbortSignal;
  resume?: boolean;
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
    resume: options.resume,
    async answer(requestId, signal) {
      while (true) {
        signal.throwIfAborted();
        const answer = readRunnerAnswer(spool, options.executionId, requestId);
        if (answer) return { answer: answer.answer };
        await delay(250, undefined, { signal });
      }
    },
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
    async handover(sequence, signal) {
      while (true) {
        signal.throwIfAborted();
        const request = readRunnerHandover(spool, options.executionId, sequence);
        if (request) return request;
        await delay(250, undefined, { signal });
      }
    },
  });
}
