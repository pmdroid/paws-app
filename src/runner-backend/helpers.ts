import { journalCaught } from "../journal";
import { appendFileSync, mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { Database } from "bun:sqlite";
import { runDir, type RunAgentOptions, type RunAgentResult, type AcpEvent } from "../acp";
import type { RunnerHelpers } from "../runner-helpers";
import type {
  PlacementAccount,
  PlacementAccounts,
  PlacementCandidate,
  RunnerPlacement,
} from "../runner-placement";
import { RunnerSlotsBusyError, systemClock, UserFacingError } from "../core";
import type { RoleAccountPolicy } from "../config";
import { dispatchAccount, immediate, runnerHasCapacity, workspaceSessionIds } from "../db";
import { FINDING_GROUPS_RUNNER_VERSION, type RunnerCommand } from "../runner-protocol";
import { versionAtLeast } from "./session-restore";
import { usageLimitWait } from "./usage-limit-wait";

import {
  AccountPolicyUnavailable,
  RetryableRunnerError,
  runWithFailover,
  USAGE_LIMIT_RESUME_SLACK_MS,
  UsageLimitPause,
} from "./failover";

type HelperCommand = Extract<RunnerCommand, { type: "helper" }>;

export function createRemoteSessionAgentRunner(options: {
  db: Database;
  helpers: RunnerHelpers;
  now?: () => number;
  mono?: () => number;
  pollIntervalMs?: number;
  placement?: RunnerPlacement;
  accountPolicy?: () => RoleAccountPolicy | undefined;
}) {
  const now = options.now ?? Date.now;
  const mono = options.mono ?? systemClock.mono;
  const earliestCooldown = (runnerIds: readonly string[], agent: string) =>
    runnerIds.length === 0
      ? null
      : options.db
          .query<{ runnerId: string; until: number }, [string, number, string]>(
            `SELECT runner_id AS runnerId,cooldown_until AS until FROM runner_agent_policy
             WHERE agent=? AND cooldown_until>? AND runner_id IN (SELECT value FROM json_each(?))
             ORDER BY cooldown_until,runner_id LIMIT 1`,
          )
          .get(agent, now(), JSON.stringify(runnerIds));
  const sessionRun = (sessionId: string) => {
    const rows = options.db
      .query<{ itemId: string; runId: string }, [string]>(
        `SELECT id AS itemId,current_run_id AS runId FROM work_item
         WHERE session_key=? AND current_run_id IS NOT NULL AND state IN ('running','verifying','recovering')
         LIMIT 2`,
      )
      .all(sessionId);
    return rows.length === 1 ? rows[0]! : null;
  };
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
        const accountPolicy = options.accountPolicy?.();
        let accounts: PlacementAccounts | undefined;
        if (accountPolicy) {
          const policy =
            accountPolicy.agent === input.profile.agent
              ? accountPolicy
              : { agent: input.profile.agent, accounts: [] };
          const choice = dispatchAccount(options.db, { sessionId }, input.profile.agent, policy);
          if (!choice.dispatch)
            throw new AccountPolicyUnavailable(input.profile.agent, choice.reason);
          accounts = {
            revision: new Bun.CryptoHasher("sha256")
              .update(JSON.stringify([policy.agent, policy.accounts]))
              .digest("hex")
              .slice(0, 16),
            accountIds: choice.admission.eligible,
          };
        }
        const profile = { ...input.profile, model: input.profile.model ?? null };
        const waitUntil = now() + (input.timeoutMs ?? 60_000);
        let command: HelperCommand | undefined;
        let placed: PlacementAccount | undefined;
        const cooling: string[] = [];
        const checks: { runnerId: string; until: number }[] = [];
        const request = {
          sessionId,
          ...(purpose === "finding_groups" ? { findingGroups: true } : {}),
          profile,
          role: input.role,
          purpose: "helper" as const,
          excludeRunnerIds: excluded,
          ...(accounts ? { accounts } : {}),
          signal: input.signal,
        };
        while (!command) {
          cooling.length = 0;
          checks.length = 0;
          const runners: readonly PlacementCandidate[] = options.placement
            ? await options.placement.candidates({
                ...request,
                onRejected: (runnerId, reason, until) => {
                  if (reason === "agent quota cooldown") cooling.push(runnerId);
                  if (until !== undefined && until > now()) checks.push({ runnerId, until });
                },
              })
            : options.db
                .query<{ id: string; workspaceId: string }, [number]>(
                  "SELECT r.id,r.workspace_id AS workspaceId FROM runner r WHERE r.status='active' AND r.revoked_at IS NULL AND r.last_seen_at>? ORDER BY r.last_seen_at DESC,r.id",
                )
                .all(now() - 60_000);
          for (const runner of runners) {
            if (
              excluded.includes(runner.id) ||
              (runner.account && excluded.includes(runner.account.bindingId))
            )
              continue;
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
              placed = runner.account;
              command = immediate(options.db, () => {
                const dispatched = options.helpers.dispatch({
                  runnerId: runner.id,
                  sessionId,
                  purpose,
                  profile,
                  prompt: input.prompt,
                  ...(runner.account?.named
                    ? {
                        account: {
                          accountId: runner.account.accountId,
                          bindingId: runner.account.bindingId,
                        },
                      }
                    : {}),
                }).command;
                options.placement?.started({
                  commandId: dispatched.id,
                  runnerId: runner.id,
                  sessionId,
                  profile,
                  ...(runner.account ? { account: runner.account } : {}),
                  ...(accounts ? { accounts } : {}),
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
          if ((!helperBusy && !workFull) || now() >= waitUntil) {
            const runnerCooldown = earliestCooldown(cooling, profile.agent);
            const cooldown = [...(runnerCooldown ? [runnerCooldown] : []), ...checks].sort(
              (a, b) => a.until - b.until,
            )[0];
            if (cooldown)
              throw new UsageLimitPause(
                profile.agent,
                cooldown.until + USAGE_LIMIT_RESUME_SLACK_MS,
                cooldown.until,
                cooldown.runnerId,
                async () =>
                  (await options.placement!.candidates(request)).map((runner) => runner.id),
              );
            throw new UserFacingError(
              `No paired runner can run ${profile.agent} for this issue right now. Check runner availability and usage limits, then retry.`,
            );
          }
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
                  undefined,
                  false,
                  undefined,
                  false,
                  false,
                  placed?.named && result.authRequired ? placed.bindingId : undefined,
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
              usageLimitWait(
                { db: options.db, now, mono, interval: options.pollIntervalMs ?? 250 },
                () => sessionRun(sessionId),
                input,
              ),
            );
    },
  };
}
