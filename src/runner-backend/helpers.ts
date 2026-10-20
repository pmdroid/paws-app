import { appendFileSync, mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { Database } from "bun:sqlite";
import { runDir, type RunAgentOptions, type RunAgentResult, type AcpEvent } from "../acp";
import type { RunnerHelpers } from "../runner-helpers";
import type { RunnerPlacement } from "../runner-placement";
import { UserFacingError } from "../core";
import { immediate, runnerHasCapacity } from "../db";
import type { RunnerCommand } from "../runner-protocol";

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
                profile,
                role: input.role,
                purpose: "helper",
                excludeRunnerIds: excluded,
                signal: input.signal,
              })
            : options.db
                .query<{ id: string; memberId?: string }, [number, number]>(
                  "SELECT r.id FROM runner r WHERE r.status='active' AND r.revoked_at IS NULL AND r.last_seen_at>? AND NOT EXISTS(SELECT 1 FROM runner_helper h WHERE h.runner_id=r.id AND h.ended_at IS NULL AND h.expires_at>?) ORDER BY r.last_seen_at DESC,r.id",
                )
                .all(now() - 60_000, now())
                .filter((runner) => runnerHasCapacity(options.db, runner.id, now()));
          for (const runner of runners) {
            if (excluded.includes(runner.id)) continue;
            try {
              command = immediate(options.db, () => {
                const dispatched = options.helpers.dispatch({
                  runnerId: runner.id,
                  ...(runner.memberId ? { memberId: runner.memberId } : {}),
                  sessionId,
                  purpose,
                  profile,
                  prompt: input.prompt,
                }).command;
                options.placement?.started({
                  commandId: dispatched.id,
                  runnerId: runner.id,
                  ...(runner.memberId ? { memberId: runner.memberId } : {}),
                  sessionId,
                  profile,
                  role: input.role,
                  purpose: "helper",
                  startedAt: now(),
                });
                return dispatched;
              });
              break;
            } catch {}
          }
          if (command) break;
          const slotBusy = options.db
            .query(
              "SELECT 1 FROM runner_helper h JOIN runner r ON r.id=h.runner_id WHERE r.status='active' AND r.revoked_at IS NULL AND h.ended_at IS NULL AND h.expires_at>?",
            )
            .get(now());
          if (!slotBusy || now() >= waitUntil)
            throw new UserFacingError(
              `No paired runner can run ${profile.agent} for this issue right now. Check runner availability and usage limits, then retry.`,
            );
          await delay(options.pollIntervalMs ?? 250, undefined, { signal: input.signal });
        }
        try {
          const deadline = Math.min(command.expiresAt, now() + (input.timeoutMs ?? 60_000));
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
          options.helpers.finish(command.id);
        }
      };
      return (input: RunAgentOptions) =>
        runWithFailover(
          { ...input, timeoutMs: input.timeoutMs ?? 60_000 },
          attempt,
          async () => {},
        );
    },
  };
}
