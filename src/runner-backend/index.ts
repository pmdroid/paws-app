import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  existsSync,
  writeFileSync,
  openSync,
  closeSync,
  fstatSync,
  constants,
} from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfigFile } from "../config";
import { join, relative, sep } from "node:path";
import type { Database } from "bun:sqlite";
import { getTaskMode, getWorkItem, immediate, runnerHasCapacity, saveCheckpoint } from "../db";
import {
  git,
  recoverAcpConversation,
  snapshotAgentInputs,
  snapshotImplementationSkills,
  runDir,
  type AcpEvent,
  type RunAgentOptions,
  type RunAgentResult,
} from "../acp";
import { RunnerWorkFencedError, type RunnerWork } from "../runner-work";
import type { RunnerResults } from "../runner-results";
import type { RunnerHealth } from "../runner-health";
import type { RunnerArtifactStore } from "../runner-artifacts";
import type { RunnerCommand, RunnerResult } from "../runner-protocol";
import type { RunnerChecks } from "../runner-checks";
import type { RunnerTranscripts } from "../runner-transcripts";
import type { RunnerInputStore } from "../runner-inputs";
import { createRemoteCloseoutCommandRunner } from "../runner-closeout";
import { workspaceId } from "../workspace";
import { createRemoteCancellation } from "./cancel";
import { RetryableRunnerError, runWithFailover } from "./failover";
import type { RunnerPlacement } from "../runner-placement";

class RunnerUnavailableError extends Error {}

type WorkCommand = Extract<RunnerCommand, { type: "run" | "review" | "task" }>;

function snapshotCommit(workspace: string, repository: { owner: string; repo: string }) {
  const fd = openSync(`${workspace}.repository.json`, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      info.size > 65536
    )
      throw new Error("Repository snapshot metadata is unsafe");
    const saved = JSON.parse(readFileSync(fd, "utf8")) as {
      owner?: unknown;
      repo?: unknown;
      commit?: unknown;
    };
    if (
      saved.owner !== repository.owner ||
      saved.repo !== repository.repo ||
      typeof saved.commit !== "string" ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(saved.commit)
    )
      throw new Error("Repository snapshot binding changed");
    return saved.commit;
  } finally {
    closeSync(fd);
  }
}

export function createRemoteAgentRunner(options: {
  db: Database;
  work: RunnerWork;
  results: RunnerResults;
  health: RunnerHealth;
  artifacts?: RunnerArtifactStore;
  checks?: RunnerChecks;
  transcripts?: Pick<RunnerTranscripts, "download">;
  inputs?: Pick<RunnerInputStore, "stage" | "stagePrompt">;
  fetchCandidate(input: {
    itemId: string;
    worktree: string;
    baseSha: string;
    candidateSha: string;
    branch: string;
    remoteUrl: string;
    networkGit: (args: string[]) => Promise<string>;
    signal: AbortSignal;
  }): Promise<void>;
  checkpointBot?: (
    repository: string,
  ) => Promise<NonNullable<Extract<RunnerCommand, { type: "run" }>["checkpointBot"]>>;
  now?: () => number;
  pollIntervalMs?: number;
  placement?: RunnerPlacement;
}) {
  const { db, work, results, health } = options;
  const now = options.now ?? Date.now;
  const interval = options.pollIntervalMs ?? 250;
  const reservations = new Map<string, string>();
  async function select(
    itemId: string,
    placement: Parameters<RunnerPlacement["candidates"]>[0],
    runnerId?: string,
  ) {
    const item = getWorkItem(db, itemId);
    if (!item?.currentRunId) throw new Error("Remote task has no current run");
    const candidates = options.placement
      ? await options.placement.candidates(placement)
      : db
          .query<{ id: string; workspaceId: string; memberId?: string }, []>(
            `SELECT r.id,r.workspace_id AS workspaceId FROM runner r
       JOIN workspace_member m ON m.workspace_id=r.workspace_id AND m.user_id=r.owner_user_id
       WHERE r.status='active' AND r.revoked_at IS NULL AND m.active=1
       AND r.last_seen_at>${now() - 60_000}
       ORDER BY r.last_seen_at DESC,r.id`,
          )
          .all();
    placement.signal?.throwIfAborted();
    for (const runner of candidates) {
      if (placement.excludeRunnerIds?.includes(runner.id)) continue;
      if (runnerId && runner.id !== runnerId) continue;
      const reserved = [...reservations].filter(
        ([runId, hostId]) =>
          hostId === runner.id &&
          !db
            .query<{ active: number }, [string, number]>(
              "SELECT 1 AS active FROM runner_work WHERE run_id=? AND ended_at IS NULL AND lease_until>?",
            )
            .get(runId, now()),
      ).length;
      if (
        reservations.has(item.currentRunId) ||
        !runnerHasCapacity(db, runner.id, now(), "", reserved)
      )
        continue;
      try {
        const mode = getTaskMode(db, itemId);
        if (mode === "answer" || mode === "artifact")
          work.scopeTask(
            item.currentRunId,
            runner.workspaceId,
            runner.memberId ?? work.identity(runner.id).userId,
          );
        else work.scope(item.currentRunId, runner.workspaceId);
        reservations.set(item.currentRunId, runner.id);
        return { ...runner, runId: item.currentRunId };
      } catch {}
    }
    throw new RunnerUnavailableError(
      "No available paired runner can access this Linear task repository",
    );
  }
  const cancelItem = createRemoteCancellation(options);
  return {
    cancelItem,
    closeoutForItem(itemId: string, signal?: AbortSignal, checkoutExclusions?: readonly string[]) {
      const attempts = new Map<
        string,
        { id: string; runnerId: string; runId: string; workspaceId: string; fence: number }
      >();
      return createRemoteCloseoutCommandRunner({
        signal,
        checkoutExclusions,
        async execute(request) {
          signal?.throwIfAborted();
          if (!options.checks) throw new Error("Trusted runner verification is unavailable");
          const checks = options.checks;
          const previous = attempts.get(request.candidateSha);
          const waitingDeadline = performance.now() + Math.min(request.timeoutMs, 60_000);
          const selectRunner = async () => {
            while (true) {
              signal?.throwIfAborted();
              if (previous) {
                const identity = work.identity(previous.runnerId);
                if (
                  identity.fence !== previous.fence ||
                  identity.status !== "active" ||
                  getWorkItem(db, itemId)?.currentRunId !== previous.runId
                )
                  throw new RunnerWorkFencedError("Runner verification authority changed");
                work.scope(previous.runId, previous.workspaceId);
              }
              try {
                return await select(
                  itemId,
                  { itemId, role: "reviewer", purpose: "check", signal },
                  previous?.runnerId,
                );
              } catch (error) {
                if (
                  !previous ||
                  !(error instanceof RunnerUnavailableError) ||
                  performance.now() >= waitingDeadline
                )
                  throw error;
                await delay(
                  Math.min(interval, Math.max(1, waitingDeadline - performance.now())),
                  undefined,
                  { signal },
                );
              }
            }
          };
          const selected = await selectRunner();
          let executionId: string | undefined;
          let completed = false;
          try {
            signal?.throwIfAborted();
            const attempt = previous ?? {
              id: workspaceId(now()),
              runnerId: selected.id,
              runId: selected.runId,
              workspaceId: selected.workspaceId,
              fence: work.identity(selected.id).fence,
            };
            const dispatched = immediate(db, () => {
              const execution = checks.dispatch({
                runnerId: selected.id,
                runId: selected.runId,
                verificationAttemptId: attempt.id,
                ...request,
              });
              const row = db
                .query<{ commandId: string }, [string]>(
                  "SELECT command_id AS commandId FROM runner_check_execution WHERE id=?",
                )
                .get(execution.input.executionId)!;
              options.placement?.started({
                commandId: row.commandId,
                runnerId: selected.id,
                itemId,
                runId: selected.runId,
                role: "reviewer",
                purpose: "check",
                startedAt: now(),
              });
              return execution;
            });
            attempts.set(request.candidateSha, attempt);
            executionId = dispatched.input.executionId;
            const assignment = db
              .query<{ generation: number; runnerFence: number }, [string]>(
                "SELECT generation,runner_fence AS runnerFence FROM runner_work WHERE run_id=?",
              )
              .get(selected.runId)!;
            const deadline = now() + request.timeoutMs + 60_000;
            while (now() < deadline) {
              signal?.throwIfAborted();
              work.scope(selected.runId, selected.workspaceId);
              if (
                work.identity(selected.id).fence !== assignment.runnerFence ||
                db
                  .query<{ generation: number }, [string]>(
                    "SELECT generation FROM runner_work WHERE run_id=?",
                  )
                  .get(selected.runId)?.generation !== assignment.generation
              )
                throw new RunnerWorkFencedError("Runner verification authority changed");
              const receipt = checks.result(executionId);
              if (receipt) {
                completed = true;
                const row = db
                  .query<{ commandId: string }, [string]>(
                    "SELECT command_id AS commandId FROM runner_check_execution WHERE id=?",
                  )
                  .get(executionId)!;
                immediate(db, () =>
                  options.placement?.finished({
                    commandId: row.commandId,
                    runnerId: selected.id,
                    finishedAt: now(),
                  }),
                );
                return receipt;
              }
              work.current(selected.runId, assignment.generation);
              await delay(interval, undefined, { signal });
            }
            throw new Error("Trusted runner verification timed out");
          } finally {
            try {
              if (executionId && !completed) checks.cancel(executionId);
            } finally {
              reservations.delete(selected.runId);
            }
          }
        },
      });
    },
    forItem(itemId: string) {
      const attempt = async (
        input: RunAgentOptions,
        excluded: readonly string[],
      ): Promise<RunAgentResult> => {
        input.signal?.throwIfAborted();
        if (!input.profile) throw new Error("Remote agent profile is required");
        const mode = getTaskMode(db, itemId);
        const responseTask = mode === "answer" || mode === "artifact";
        if (
          responseTask &&
          (input.role !== "implementer" ||
            (!input.prepareOnly && Boolean(input.readOnly) !== (mode === "answer")))
        )
          throw new Error("Remote response task role or access changed");
        if (responseTask && !options.transcripts)
          throw new Error("Remote response task transcript is unavailable");
        if (!responseTask && !input.prepareOnly && input.readOnly && input.role !== "reviewer")
          throw new Error("Read-only remote work requires the reviewer role");
        const suppliedInputs = snapshotAgentInputs(input.worktreePath, input.inputFiles);
        const profile = { ...input.profile, model: input.profile.model ?? null };
        const selected = await select(itemId, {
          itemId,
          profile,
          role: input.role,
          purpose: input.prepareOnly ? "prepare" : "work",
          excludeRunnerIds: excluded,
          signal: input.signal,
        });
        const controller = new AbortController();
        const abort = () => controller.abort(input.signal?.reason);
        input.signal?.addEventListener("abort", abort, { once: true });
        if (input.signal?.aborted) abort();
        const signal = controller.signal;
        let command: WorkCommand | undefined;
        let question: Promise<void> | undefined;
        let questionError: unknown;
        let publishedEffects = false;
        let transcriptBytes = 0;
        let previousTranscript = Buffer.alloc(0);
        const transcript = `${runDir(input.pawsRoot, input.runId)}/acp.jsonl`;
        const emit = async (event: AcpEvent) => {
          const line = `${JSON.stringify({ event })}\n`;
          transcriptBytes += Buffer.byteLength(line);
          if (transcriptBytes > 16_777_216) throw new Error("Remote transcript exceeds limit");
          appendFileSync(transcript, line, { mode: 0o600 });
          await input.onEvent?.(event);
        };
        try {
          const taskScope = responseTask
            ? work.scopeTask(
                selected.runId,
                selected.workspaceId,
                selected.memberId ?? work.identity(selected.id).userId,
              )
            : undefined;
          mkdirSync(runDir(input.pawsRoot, input.runId), { recursive: true, mode: 0o700 });
          signal.throwIfAborted();
          if (options.transcripts && existsSync(transcript))
            previousTranscript = readFileSync(transcript);
          if (input.prepareOnly) {
            const id = randomUUID();
            const issuedAt = now();
            immediate(db, () => {
              work.enqueue({
                id,
                runnerId: selected.id,
                workspaceId: selected.workspaceId,
                ...(selected.memberId ? { memberId: selected.memberId } : {}),
                issuedAt,
                expiresAt: issuedAt + 120_000,
                type: "probe",
                profile,
              });
              options.placement?.started({
                commandId: id,
                runnerId: selected.id,
                itemId,
                runId: selected.runId,
                profile,
                role: input.role,
                purpose: "prepare",
                startedAt: issuedAt,
              });
            });
            while (now() < issuedAt + 120_000) {
              signal.throwIfAborted();
              if (taskScope)
                work.scopeTask(
                  selected.runId,
                  selected.workspaceId,
                  selected.memberId ?? work.identity(selected.id).userId,
                );
              else work.scope(selected.runId, selected.workspaceId);
              const result = health.read(selected.id, id);
              if (result) {
                const disposition = immediate(db, () =>
                  options.placement?.finished({
                    commandId: id,
                    runnerId: selected.id,
                    profile,
                    result,
                    finishedAt: now(),
                  }),
                );
                if (
                  disposition?.retryable &&
                  result.agentExited &&
                  !result.cancelled &&
                  !result.timedOut
                )
                  throw new RetryableRunnerError(
                    selected.id,
                    result.authRequired
                      ? "The runner agent requires sign-in."
                      : "The runner agent exhausted its observed quota.",
                  );
                return { ...result, role: input.role, transcriptPath: transcript };
              }
              await delay(interval, undefined, { signal });
            }
            throw new Error("Remote agent preparation timed out");
          }
          const prepared = input.prepareInputFiles
            ? await input.prepareInputFiles({
                workspace: input.worktreePath,
                prompt: input.prompt,
                signal,
              })
            : { prompt: input.prompt, inputFiles: [] };
          const scoped = taskScope ?? work.scope(selected.runId, selected.workspaceId);
          const files = snapshotAgentInputs(input.worktreePath, [
            ...suppliedInputs,
            ...prepared.inputFiles,
          ]);
          const skillBundle =
            !taskScope && input.role === "implementer"
              ? await snapshotImplementationSkills({
                  pawsRoot: input.pawsRoot,
                  worktree: input.worktreePath,
                  repository: `${scoped.repository!.owner}/${scoped.repository!.repo}`,
                  signal,
                })
              : undefined;
          const skillsInputId = skillBundle ? files.length : undefined;
          if (skillBundle)
            files.push({
              path: `${input.worktreePath}/.paws-skills-${randomUUID()}.json`,
              mimeType: "application/vnd.paws.skills+json",
              bytes: skillBundle,
            });
          if (files.length && !options.inputs)
            throw new Error("Remote agent input transfer is unavailable");
          if (prepared.prompt.length > 65_536 && !options.inputs)
            throw new Error("Remote conversation context transfer is unavailable");
          const commandId = randomUUID();
          const inputFiles = files.length
            ? options.inputs!.stage(
                commandId,
                files.map((file) => ({
                  ...file,
                  path: relative(input.worktreePath, file.path).split(sep).join("/"),
                })),
              )
            : undefined;
          const promptContext =
            prepared.prompt.length > 65_536
              ? options.inputs!.stagePrompt(commandId, prepared.prompt)
              : undefined;
          const baseSha = taskScope
            ? taskScope.repository
              ? snapshotCommit(input.worktreePath, taskScope.repository)
              : undefined
            : (await git(["-C", input.worktreePath, "rev-parse", "HEAD"])).trim();
          if (!taskScope && !scoped.item.checkpoint && input.role === "implementer")
            saveCheckpoint(db, itemId, { phase: "running", baseSha, wipCommit: baseSha });
          const generation =
            (db
              .query<{ generation: number }, [string]>(
                "SELECT generation FROM runner_work WHERE run_id=?",
              )
              .get(selected.runId)?.generation ?? 0) + 1;
          const issuedAt = now();
          const deadline = issuedAt + (input.timeoutMs ?? 2_700_000);
          const checkpointBot =
            !taskScope && input.role === "implementer"
              ? await options.checkpointBot?.(
                  `${scoped.repository!.owner}/${scoped.repository!.repo}`,
                )
              : undefined;
          if (
            input.commitPolicy &&
            checkpointBot &&
            (input.commitPolicy.bot.appId !== checkpointBot.appId ||
              input.commitPolicy.bot.id !== checkpointBot.id ||
              input.commitPolicy.bot.login !== checkpointBot.login)
          )
            throw new Error("Run attribution App bot authority changed");
          signal.throwIfAborted();
          const boundRepository = taskScope?.repository ?? scoped.repository;
          const checkoutExclusions = input.checkoutExclusions
            ? [...input.checkoutExclusions]
            : boundRepository
              ? loadConfigFile(join(input.pawsRoot, "config.toml")).checkoutProjects?.[
                  `${boundRepository.owner}/${boundRepository.repo}`.toLowerCase()
                ]?.exclude
              : undefined;
          const assigned: WorkCommand = {
            id: commandId,
            runnerId: selected.id,
            workspaceId: selected.workspaceId,
            ...(selected.memberId ? { memberId: selected.memberId } : {}),
            issuedAt,
            expiresAt: deadline,
            runId: selected.runId,
            itemId,
            generation,
            profile,
            prompt: promptContext
              ? "Use the complete supplied conversation context."
              : prepared.prompt,
            inputFiles,
            promptContext,
            ...(taskScope
              ? {
                  type: "task" as const,
                  sessionId: taskScope.sessionId,
                  sessionGeneration: taskScope.sessionGeneration,
                  taskModeGeneration: taskScope.taskModeGeneration,
                  purpose: taskScope.purpose,
                  ...(taskScope.repository
                    ? {
                        repository: {
                          ...taskScope.repository,
                          baseSha: baseSha!,
                          checkoutExclusions,
                        },
                      }
                    : {}),
                }
              : {
                  type: input.role === "reviewer" ? ("review" as const) : ("run" as const),
                  ...(skillsInputId !== undefined ? { skillsInputId } : {}),
                  repository: { ...scoped.repository!, baseSha: baseSha!, checkoutExclusions },
                  ...(checkpointBot ? { checkpointBot } : {}),
                  ...(input.commitPolicy
                    ? { commitPolicy: input.commitPolicy, checkpointBot: input.commitPolicy.bot }
                    : {}),
                }),
          };
          immediate(db, () => {
            if (!runnerHasCapacity(db, selected.id, now()))
              throw new Error("Runner became busy before assignment");
            work.assign(assigned);
            options.placement?.started({
              commandId: assigned.id,
              runnerId: selected.id,
              itemId,
              runId: selected.runId,
              profile,
              role: input.role,
              purpose: "work",
              startedAt: issuedAt,
            });
          });
          command = assigned;
          let cursor = 0;
          let complete: RunnerResult | null = null;
          let disposition: { retryable: boolean } | undefined;
          while (now() < deadline) {
            signal.throwIfAborted();
            work.current(assigned.runId, assigned.generation);
            if (questionError) throw questionError;
            complete = results.read(assigned.runId, assigned.generation, assigned.id);
            if (complete && !disposition)
              disposition = immediate(db, () =>
                options.placement?.finished({
                  commandId: assigned.id,
                  runnerId: selected.id,
                  profile,
                  result: complete!,
                  finishedAt: now(),
                }),
              );
            if (complete && disposition?.retryable && input.role === "reviewer")
              throw new RetryableRunnerError(
                selected.id,
                "The reviewer runner requires a fresh eligible agent.",
                transcript,
                publishedEffects,
              );
            const pendingEvents = results.events(assigned.runId, assigned.generation, cursor);
            for (const row of pendingEvents) {
              const event = row.event;
              if (event.type === "progress" && taskScope)
                await emit({ type: "progress", text: event.text });
              else if (event.type === "progress")
                await emit({
                  type: "session_update",
                  sessionId: assigned.id,
                  update: {
                    sessionUpdate:
                      input.role === "reviewer" ? "agent_thought_chunk" : "agent_message_chunk",
                    content: { type: "text", text: event.text },
                  },
                });
              if (event.type === "artifact") {
                if (!input.publishArtifact || !options.artifacts)
                  throw new Error("Remote artifact publication is unavailable");
                const snapshot = options.artifacts.snapshot(
                  assigned.runId,
                  assigned.generation,
                  event.artifact,
                );
                const publication = await input.publishArtifact.publish(snapshot, {
                  request: {
                    path: snapshot.path,
                    displayName: snapshot.displayName,
                    mimeType: snapshot.mimeType,
                    attachToIssue: event.artifact.attachToIssue,
                  },
                  itemId: input.itemId,
                  runId: selected.runId,
                  worktreePath: input.worktreePath,
                  role: input.role,
                  signal,
                });
                publishedEffects = true;
                signal.throwIfAborted();
                results.answer({
                  runId: assigned.runId,
                  generation: assigned.generation,
                  sequence: row.sequence,
                  answer: JSON.stringify(publication),
                });
              }
              if (event.type === "question") {
                if (question) throw new Error("Remote runner sent overlapping questions");
                if (!input.askTeam) throw new Error("Remote question channel is unavailable");
                publishedEffects = true;
                await emit({ type: "ask_team", question: event.text, phase: "asked" });
                const currentCommand = assigned;
                question = (async () => {
                  const answer = await input.askTeam!.ask(
                    { question: event.text, options: event.options },
                    { itemId: input.itemId, runId: selected.runId, role: input.role, signal },
                  );
                  signal.throwIfAborted();
                  results.answer({
                    runId: currentCommand.runId,
                    generation: currentCommand.generation,
                    sequence: row.sequence,
                    answer: answer.answer,
                  });
                  await emit({
                    type: "ask_team",
                    question: event.text,
                    phase: "answered",
                    answer: answer.answer,
                  });
                })()
                  .catch((error) => {
                    questionError = error;
                  })
                  .finally(() => {
                    question = undefined;
                  });
              }
              cursor = row.sequence;
            }
            if (complete && pendingEvents.length < 64) break;
            if (pendingEvents.length === 64) continue;
            if (!complete && results.read(assigned.runId, assigned.generation, assigned.id))
              continue;
            if (
              options.placement &&
              (db
                .query<{ lastSeen: number | null }, [string]>(
                  "SELECT last_seen_at AS lastSeen FROM runner WHERE id=?",
                )
                .get(selected.id)?.lastSeen ?? 0) <=
                now() - 60_000
            ) {
              const lost = immediate(db, () =>
                options.placement?.finished({
                  commandId: assigned.id,
                  runnerId: selected.id,
                  profile,
                  failure: "heartbeat_lost",
                  finishedAt: now(),
                }),
              );
              if (!lost?.retryable) throw new Error("The runner stopped sending heartbeats.");
              throw new RetryableRunnerError(
                selected.id,
                "The runner stopped sending heartbeats.",
                transcript,
                publishedEffects,
              );
            }
            await delay(interval, undefined, { signal });
          }
          if (!complete) throw new Error("Remote run timed out");
          if (question) throw new Error("Remote run completed with an unanswered question");
          if (assigned.type === "task" && (complete.candidateSha || complete.reviewText))
            throw new Error("Remote response task returned code work");
          if (options.transcripts) {
            work.current(assigned.runId, assigned.generation);
            const bytes = await options.transcripts.download(
              assigned.runId,
              assigned.generation,
              complete.executionId,
            );
            signal.throwIfAborted();
            work.current(assigned.runId, assigned.generation);
            if (bytes.length > 16_777_216 || (bytes.length && bytes[bytes.length - 1] !== 10))
              throw new Error("Remote transcript is incomplete");
            const pending = `${transcript}.${randomUUID()}.pending`;
            try {
              writeFileSync(pending, Buffer.concat([previousTranscript, bytes]), {
                flag: "wx",
                mode: 0o600,
              });
              renameSync(pending, transcript);
            } finally {
              rmSync(pending, { force: true });
            }
          }
          if (
            disposition?.retryable &&
            complete.agentExited &&
            !complete.cancelled &&
            !complete.timedOut &&
            !complete.candidateSha
          )
            throw new RetryableRunnerError(
              selected.id,
              complete.authRequired
                ? "The runner agent requires sign-in."
                : "The runner agent exhausted its observed quota.",
              transcript,
              publishedEffects,
            );
          if (complete.reviewText)
            await emit({
              type: "session_update",
              sessionId: complete.sessionId ?? assigned.id,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: complete.reviewText },
              },
            });
          if (
            assigned.type === "run" &&
            complete.stopReason === "end_turn" &&
            !complete.cancelled &&
            !complete.timedOut &&
            !complete.authRequired &&
            complete.agentExited &&
            !complete.errorMessage &&
            !complete.candidateSha
          )
            throw new Error("Remote implementation has no candidate commit");
          if (complete.candidateSha) {
            if (assigned.type !== "run" || !input.networkGit)
              throw new Error("Runner candidate requires an authorized implementation import.");
            await options.fetchCandidate({
              itemId,
              worktree: input.worktreePath,
              baseSha: baseSha!,
              candidateSha: complete.candidateSha,
              branch: scoped.item.branchName,
              remoteUrl: assigned.repository.remoteUrl,
              networkGit: input.networkGit,
              signal,
            });
            signal.throwIfAborted();
            work.current(assigned.runId, assigned.generation);
            if (
              (await git(["-C", input.worktreePath, "rev-parse", "HEAD"])).trim() !==
              complete.candidateSha
            )
              throw new Error("Fetched runner candidate HEAD does not match");
            await git([
              "-C",
              input.worktreePath,
              "merge-base",
              "--is-ancestor",
              baseSha!,
              complete.candidateSha,
            ]);
          }
          if (assigned.type === "task") {
            const history = await recoverAcpConversation(transcript, previousTranscript.length);
            signal.throwIfAborted();
            work.current(assigned.runId, assigned.generation);
            const text = history
              .filter((entry) => entry.kind === "response")
              .map((entry) => entry.body)
              .join("\n\n");
            if (text)
              await input.onEvent?.({
                type: "session_update",
                sessionId: complete.sessionId ?? assigned.id,
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
              });
            signal.throwIfAborted();
            work.current(assigned.runId, assigned.generation);
          }
          work.finish(assigned.runId, assigned.generation);
          command = undefined;
          await emit({ type: "prompt_complete", stopReason: complete.stopReason });
          return { ...complete, transcriptPath: transcript };
        } finally {
          if (command) {
            try {
              const issuedAt = now();
              work.enqueue({
                id: randomUUID(),
                runnerId: selected.id,
                workspaceId: selected.workspaceId,
                ...(selected.memberId ? { memberId: selected.memberId } : {}),
                issuedAt,
                expiresAt: issuedAt + 60_000,
                type: "cancel",
                runId: command.runId,
                generation: command.generation,
              });
            } catch {}
          }
          controller.abort();
          await question;
          input.signal?.removeEventListener("abort", abort);
          reservations.delete(selected.runId);
        }
      };
      return (input: RunAgentOptions) =>
        runWithFailover(input, attempt, async () => cancelItem(itemId, input.signal));
    },
  };
}

export { createRemoteSessionAgentRunner } from "./helpers";

export { fetchRunnerCandidate } from "./candidate";
