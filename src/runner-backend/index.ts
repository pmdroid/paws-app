import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { Database } from "bun:sqlite";
import { getWorkItem, immediate, saveCheckpoint } from "../db";
import { git, runDir, type AcpEvent, type RunAgentOptions, type RunAgentResult } from "../acp";
import { RunnerWorkFencedError, type RunnerWork } from "../runner-work";
import type { RunnerResults } from "../runner-results";
import type { RunnerHealth } from "../runner-health";
import type { RunnerArtifactStore } from "../runner-artifacts";
import type { RunnerCommand, RunnerResult } from "../runner-protocol";
import type { RunnerChecks } from "../runner-checks";
import type { RunnerTranscripts } from "../runner-transcripts";
import { createRemoteCloseoutCommandRunner } from "../runner-closeout";
import { workspaceId } from "../workspace";

class RunnerUnavailableError extends Error {}
export { createRemoteSessionAgentRunner } from "./helpers";

type WorkCommand = Extract<RunnerCommand, { type: "run" | "review" }>;

export function createRemoteAgentRunner(options: {
  db: Database;
  work: RunnerWork;
  results: RunnerResults;
  health: RunnerHealth;
  artifacts?: RunnerArtifactStore;
  checks?: RunnerChecks;
  transcripts?: Pick<RunnerTranscripts, "download">;
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
  now?: () => number;
  pollIntervalMs?: number;
}) {
  const { db, work, results, health } = options;
  const now = options.now ?? Date.now;
  const interval = options.pollIntervalMs ?? 250;
  const reservations = new Set<string>();
  function select(itemId: string, runnerId?: string) {
    const item = getWorkItem(db, itemId);
    if (!item?.currentRunId) throw new Error("Remote task has no current run");
    const candidates = db
      .query<{ id: string; workspaceId: string }, []>(
        `SELECT r.id,r.workspace_id AS workspaceId FROM runner r
       JOIN workspace_member m ON m.workspace_id=r.workspace_id AND m.user_id=r.owner_user_id
       WHERE r.status='active' AND r.revoked_at IS NULL AND m.active=1
       AND r.last_seen_at>${now() - 60_000}
       AND NOT EXISTS(SELECT 1 FROM runner_work w WHERE w.runner_id=r.id AND w.ended_at IS NULL AND w.lease_until>${now()})
       ORDER BY r.last_seen_at DESC,r.id`,
      )
      .all();
    for (const runner of candidates) {
      if (runnerId && runner.id !== runnerId) continue;
      if (reservations.has(runner.id)) continue;
      try {
        work.scope(item.currentRunId, runner.workspaceId);
        reservations.add(runner.id);
        return { ...runner, runId: item.currentRunId };
      } catch {}
    }
    throw new RunnerUnavailableError(
      "No available paired runner can access this Linear task repository",
    );
  }
  return {
    closeoutForItem(itemId: string, signal?: AbortSignal) {
      const attempts = new Map<
        string,
        { id: string; runnerId: string; runId: string; workspaceId: string; fence: number }
      >();
      return createRemoteCloseoutCommandRunner({
        signal,
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
                return select(itemId, previous?.runnerId);
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
            const dispatched = checks.dispatch({
              runnerId: selected.id,
              runId: selected.runId,
              verificationAttemptId: attempt.id,
              ...request,
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
              reservations.delete(selected.id);
            }
          }
        },
      });
    },
    forItem(itemId: string) {
      return async (input: RunAgentOptions): Promise<RunAgentResult> => {
        input.signal?.throwIfAborted();
        if (!input.profile) throw new Error("Remote agent profile is required");
        if (!input.prepareOnly && input.readOnly && input.role !== "reviewer")
          throw new Error("Read-only remote work requires the reviewer role");
        const profile = { ...input.profile, model: input.profile.model ?? null };
        const selected = select(itemId);
        const controller = new AbortController();
        const abort = () => controller.abort(input.signal?.reason);
        input.signal?.addEventListener("abort", abort, { once: true });
        if (input.signal?.aborted) abort();
        const signal = controller.signal;
        let command: WorkCommand | undefined;
        let question: Promise<void> | undefined;
        let questionError: unknown;
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
          mkdirSync(runDir(input.pawsRoot, input.runId), { recursive: true, mode: 0o700 });
          signal.throwIfAborted();
          if (options.transcripts && existsSync(transcript))
            previousTranscript = readFileSync(transcript);
          if (input.prepareOnly) {
            const id = randomUUID();
            const issuedAt = now();
            work.enqueue({
              id,
              runnerId: selected.id,
              workspaceId: selected.workspaceId,
              issuedAt,
              expiresAt: issuedAt + 120_000,
              type: "probe",
              profile,
            });
            while (now() < issuedAt + 120_000) {
              signal.throwIfAborted();
              work.scope(selected.runId, selected.workspaceId);
              const result = health.read(selected.id, id);
              if (result) return { ...result, role: input.role, transcriptPath: transcript };
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
          const files = [...(input.inputFiles ?? []), ...prepared.inputFiles];
          if (files.length) throw new Error("Remote agent input transfer is unavailable");
          const baseSha = (await git(["-C", input.worktreePath, "rev-parse", "HEAD"])).trim();
          const scoped = work.scope(selected.runId, selected.workspaceId);
          if (!scoped.item.checkpoint && input.role === "implementer")
            saveCheckpoint(db, itemId, { phase: "running", baseSha, wipCommit: baseSha });
          const generation =
            (db
              .query<{ generation: number }, [string]>(
                "SELECT generation FROM runner_work WHERE run_id=?",
              )
              .get(selected.runId)?.generation ?? 0) + 1;
          const issuedAt = now();
          const deadline = issuedAt + (input.timeoutMs ?? 2_700_000);
          const assigned: WorkCommand = {
            id: randomUUID(),
            runnerId: selected.id,
            workspaceId: selected.workspaceId,
            issuedAt,
            expiresAt: deadline,
            type: input.role === "reviewer" ? "review" : "run",
            runId: selected.runId,
            itemId,
            generation,
            repository: { ...scoped.repository, baseSha },
            profile,
            prompt: prepared.prompt,
          };
          immediate(db, () => {
            const occupied = db
              .query(
                "SELECT 1 FROM runner_work WHERE runner_id=? AND ended_at IS NULL AND lease_until>?",
              )
              .get(selected.id, now());
            if (occupied) throw new Error("Runner became busy before assignment");
            work.assign(assigned);
          });
          command = assigned;
          let cursor = 0;
          let complete: RunnerResult | null = null;
          while (now() < deadline) {
            signal.throwIfAborted();
            work.current(assigned.runId, assigned.generation);
            if (questionError) throw questionError;
            const pendingEvents = results.events(assigned.runId, assigned.generation, cursor);
            for (const row of pendingEvents) {
              const event = row.event;
              if (event.type === "progress")
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
            complete = results.read(assigned.runId, assigned.generation, assigned.id);
            if (complete && pendingEvents.length < 64) break;
            await delay(interval, undefined, { signal });
          }
          if (!complete) throw new Error("Remote run timed out");
          if (question) throw new Error("Remote run completed with an unanswered question");
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
              baseSha,
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
              baseSha,
              complete.candidateSha,
            ]);
          }
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
          reservations.delete(selected.id);
        }
      };
    },
  };
}

export { fetchRunnerCandidate } from "./candidate";
