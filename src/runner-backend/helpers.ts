import { journalCaught } from "../journal";
import { appendFileSync, mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { Database } from "bun:sqlite";
import { runDir, type RunAgentOptions, type RunAgentResult, type AcpEvent } from "../acp";
import type { RunnerHelpers } from "../runner-helpers";
import type { RunnerPlacement } from "../runner-placement";
import { RunnerSlotsBusyError, UserFacingError } from "../core";
import { immediate, runnerHasCapacity, workspaceSessionIds } from "../db";
import { FINDING_GROUPS_RUNNER_VERSION, type RunnerCommand } from "../runner-protocol";
import { versionAtLeast } from "./session-restore";

import { RetryableRunnerError, runWithFailover } from "./failover";

type HelperCommand = Extract<RunnerCommand, { type: "helper" }>;

export function createRemoteSessionAgentRunner(options: {
  db: Database;
  helpers: RunnerHelpers;
  now?: () => number;
  pollIntervalMs?: number;
  placement?: RunnerPlacement;
}) {
  const now = options.now ?? Date.now;
  return {
    forSession(sessionId: string, purpose: HelperCommand["purpose"]) {
      const attempt = async (
        input: RunAgentOptions,
        excluded: readonly string[],
      ): Promise<RunAgentResult> => {
        input.signal?.throwIfAborted();
        if (
          input.role !== "implementer" ||
          !input.profile ||
          !input.readOnly ||
          input.prepareOnly ||
          input.prepareInputFiles ||
          input.inputFiles?.length ||
          input.askTeam ||
          input.publishArtifact
        )
          throw new Error(
            "Remote session helper requires a read-only prompt without tools or files",
          );
        const profile = { ...input.profile, model: input.profile.model ?? null };
        const waitUntil = now() + (input.timeoutMs ?? 60_000);
        let command: HelperCommand | undefined;
        while (!command) {
          const runners = options.placement
            ? await options.placement.candidates({
                sessionId,
                ...(purpose === "finding_groups" ? { findingGroups: true } : {}),
                profile,
                role: input.role,
                purpose: "helper",
                excludeRunnerIds: excluded,
                signal: input.signal,
              })
            : options.db
                .query<{ id: string }, [number]>(
                  "SELECT r.id FROM runner r WHERE r.status='active' AND r.revoked_at IS NULL AND r.last_seen_at>? ORDER BY r.last_seen_at DESC,r.id",
                )
                .all(now() - 60_000);
          for (const runner of runners) {
            if (excluded.includes(runner.id)) continue;
            if (purpose === "finding_groups") {
              const host = options.db
                .query<{ version: string | null }, [string]>(
                  "SELECT runner_version AS version FROM runner_host_status WHERE runner_id=?",
                )
                .get(runner.id);
              if (!versionAtLeast(host?.version, FINDING_GROUPS_RUNNER_VERSION)) continue;
              const owner = options.db
                .query<{ workspaceId: string; userId: string }, [string]>(
                  "SELECT workspace_id AS workspaceId, owner_user_id AS userId FROM runner WHERE id=?",
                )
                .get(runner.id);
              const installation = options.db
                .query<{ clientId: string | null }, [string]>(
                  "SELECT oauth_client_id AS clientId FROM linear_session WHERE session_id=?",
                )
                .get(sessionId);
              if (
                !owner ||
                !installation?.clientId ||
                !workspaceSessionIds(
                  options.db,
                  owner.workspaceId,
                  owner.userId,
                  installation.clientId,
                ).includes(sessionId)
              )
                continue;
            }
            try {
              command = immediate(options.db, () => {
                const dispatched = options.helpers.dispatch({
                  runnerId: runner.id,
                  sessionId,
                  purpose,
                  profile,
                  prompt: input.prompt,
                }).command;
                options.placement?.started({
                  commandId: dispatched.id,
                  runnerId: runner.id,
                  sessionId,
                  profile,
                  role: input.role,
                  purpose: "helper",
                  startedAt: now(),
                });
                return dispatched;
              });
              break;
            } catch (caughtError1) {
              journalCaught(caughtError1, "helpers.forSession.immediate", null);
            }
          }
          if (command) break;
          const helperBusy = options.db
            .query(
              "SELECT 1 FROM runner_helper h JOIN runner r ON r.id=h.runner_id WHERE r.status='active' AND r.revoked_at IS NULL AND h.ended_at IS NULL AND h.expires_at>?",
            )
            .get(now());
          const workFull = options.db
            .query<{ id: string }, []>(
              "SELECT id FROM runner WHERE status='active' AND revoked_at IS NULL",
            )
            .all()
            .some((runner) => !runnerHasCapacity(options.db, runner.id, now()));
          if (workFull && now() >= waitUntil) throw new RunnerSlotsBusyError();
          if ((!helperBusy && !workFull) || now() >= waitUntil)
            throw new UserFacingError(
              `No paired runner can run ${profile.agent} for this issue right now. Check runner availability and usage limits, then retry.`,
            );
          await delay(options.pollIntervalMs ?? 250, undefined, { signal: input.signal });
        }
        let accounted = false;
        const deadline = Math.min(command.expiresAt, now() + (input.timeoutMs ?? 60_000));
        try {
          while (now() < deadline) {
            input.signal?.throwIfAborted();
            const result = options.helpers.result(command.id);
            if (result) {
              const disposition = immediate(options.db, () =>
                options.placement?.finished({
                  commandId: command!.id,
                  runnerId: command!.runnerId,
                  profile,
                  result,
                  finishedAt: now(),
                }),
              );
              accounted = true;
              if (
                disposition?.retryable &&
                result.agentExited &&
                !result.cancelled &&
                !result.timedOut
              )
                throw new RetryableRunnerError(
                  command.runnerId,
                  result.authRequired
                    ? "The runner agent requires sign-in."
                    : "The runner agent exhausted its observed quota.",
                );
              if (purpose === "finding_groups") {
                if (
                  result.errorMessage ||
                  result.stopReason !== "end_turn" ||
                  result.timedOut ||
                  result.cancelled ||
                  result.authRequired ||
                  !result.agentExited
                )
                  throw new Error(
                    result.errorMessage ?? "Finding grouping helper did not complete.",
                  );
                await input.onEvent?.({
                  type: "session_update",
                  sessionId: result.sessionId ?? command.id,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: result.text },
                  },
                });
                return { ...result, transcriptPath: "" };
              }
              const transcriptRunId = command.purpose === "classify" ? input.runId : command.id;
              const transcript = `${runDir(input.pawsRoot, transcriptRunId)}/acp.jsonl`;
              mkdirSync(runDir(input.pawsRoot, transcriptRunId), { recursive: true, mode: 0o700 });
              const events: AcpEvent[] = [
                {
                  type: "session_update",
                  sessionId: result.sessionId ?? command.id,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: result.text },
                  },
                },
                { type: "prompt_complete", stopReason: result.stopReason },
              ];
              for (const event of events) {
                input.signal?.throwIfAborted();
                options.helpers.current(command.id);
                appendFileSync(
                  transcript,
                  `${JSON.stringify({ t: new Date(now()).toISOString(), event })}\n`,
                  { mode: 0o600 },
                );
                await input.onEvent?.(event);
              }
              input.signal?.throwIfAborted();
              options.helpers.current(command.id);
              return { ...result, transcriptPath: transcript };
            }
            await delay(options.pollIntervalMs ?? 250, undefined, { signal: input.signal });
          }
          throw new Error("Remote session helper timed out");
        } finally {
          // A locally aborted or expired helper is not evidence of a lost runner heartbeat.
          // Cleanup failures must not replace the original timeout, fence or cancellation error.
          try {
            if (!accounted)
              immediate(options.db, () =>
                options.placement?.finished({
                  commandId: command.id,
                  runnerId: command.runnerId,
                  profile,
                  failure: input.signal?.aborted
                    ? input.signal.reason instanceof Error &&
                      input.signal.reason.name === "TimeoutError"
                      ? "timeout"
                      : "cancelled"
                    : now() >= deadline
                      ? "timeout"
                      : "error",
                  finishedAt: now(),
                }),
              );
          } catch (error) {
            journalCaught(error, "helpers.forSession.accountingCleanup", null);
          }
          try {
            options.helpers.finish(command.id);
          } catch (error) {
            journalCaught(error, "helpers.forSession.finishCleanup", null);
          }
        }
      };
      return (input: RunAgentOptions) =>
        purpose === "finding_groups"
          ? attempt(input, [])
          : runWithFailover(
              { ...input, timeoutMs: input.timeoutMs ?? 60_000 },
              attempt,
              async () => {},
            );
    },
  };
}
