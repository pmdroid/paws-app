import { journal as writeJournal, journalCaught } from "../journal";
import { appendFileSync, mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { Database } from "bun:sqlite";
import { runDir, type RunAgentOptions, type RunAgentResult, type AcpEvent } from "../acp";
import { RunnerHelperBusyError, type RunnerHelpers } from "../runner-helpers";
import type { PlacementAccount, PlacementCandidate, RunnerPlacement } from "../runner-placement";
import { RunnerSlotsBusyError, systemClock, UserFacingError } from "../core";
import {
  earliestRunnerCooldownSteps,
  getRunnerSteps,
  linearSessionClientIdSteps,
  recentRunnersSteps,
  runnerHelperAvailability,
  runnerHostVersionSteps,
  runnerOwnerSteps,
  sessionActiveRuns,
  sqliteDb,
  workspaceSessionIds,
  type Db,
} from "../db";
import {
  FINDING_GROUPS_RUNNER_VERSION,
  type RunnerCommand,
  type RunnerHelperResult,
} from "../runner-protocol";
import { versionAtLeast } from "./session-restore";
import { syncSteps } from "./sync-steps";
import { usageLimitWait } from "./usage-limit-wait";

import {
  RetryableRunnerError,
  runWithFailover,
  USAGE_LIMIT_RESUME_SLACK_MS,
  UsageLimitPause,
} from "./failover";

type HelperCommand = Extract<RunnerCommand, { type: "helper" }>;

const HELD_JOURNAL_INTERVAL_MS = 5 * 60_000;
const HELPER_LANE_BUSY = "Queued: the runner's helper lane is busy. Paws retries when it frees.";

/** A placement rejection that only says the runner is full: a wait, not a cause. */
const AT_CAPACITY = /(no free capacity|account at its concurrency limit)$/;

/** Rejections of runners the requester may not use at all. */
const NOT_THIS_TASKS = new Set(["not-yours", "not-shared", "no-project-lead"]);

/** Each runner's reasons, by runner name, so a failure says why every runner refused. */
function noRunnerMessage(agent: string, reasons: ReadonlyMap<string, ReadonlySet<string>>): string {
  const named = reasons.size
    ? `: ${[...reasons].map(([runner, why]) => `${runner}: ${[...why].join(", ")}`).join("; ")}.`
    : ".";
  return `No paired runner can run ${agent} for this issue right now${named} Check runner availability and usage limits, then retry.`;
}

export function createRemoteSessionAgentRunner(options: {
  db: Database;
  store?: Db;
  helpers: RunnerHelpers;
  now?: () => number;
  mono?: () => number;
  pollIntervalMs?: number;
  placement?: RunnerPlacement;
  journal?: (line: string) => void;
}) {
  const store = options.store ?? sqliteDb(options.db);
  const now = options.now ?? Date.now;
  const mono = options.mono ?? systemClock.mono;
  const heldJournaled = new Map<string, number>();
  const noteHeld = (runnerId: string) => {
    const last = heldJournaled.get(runnerId);
    if (last !== undefined && now() - last < HELD_JOURNAL_INTERVAL_MS) return;
    heldJournaled.set(runnerId, now());
    (options.journal ?? writeJournal)(
      `runner ${runnerId}: holding back helper requests while its helper lane is taken`,
    );
  };
  const waiters = new Map<string, number>();
  const earliestCooldown = async (runnerIds: readonly string[], agent: string) =>
    runnerIds.length === 0
      ? null
      : store.run((q) => earliestRunnerCooldownSteps(q, { agent, now: now(), runnerIds }));
  const sessionRun = async (sessionId: string) => {
    const rows = sessionActiveRuns(options.db, sessionId);
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
        const profile = { ...input.profile, model: input.profile.model ?? null };
        const waitUntil = now() + (input.timeoutMs ?? 60_000);
        let command: HelperCommand | undefined;
        let placed: PlacementAccount | undefined;
        const cooling: string[] = [];
        const checks: { runnerId: string; until: number }[] = [];
        const reasons = new Map<string, Set<string>>();
        const note = (runnerId: string, reason: string) =>
          reasons.set(runnerId, (reasons.get(runnerId) ?? new Set()).add(reason));
        const held = new Set<string>();
        let slotBusy = false;
        const request = {
          sessionId,
          ...(purpose === "finding_groups" ? { findingGroups: true } : {}),
          profile,
          role: input.role,
          purpose: "helper" as const,
          excludeRunnerIds: excluded,
          signal: input.signal,
        };
        while (!command) {
          cooling.length = 0;
          checks.length = 0;
          reasons.clear();
          slotBusy = false;
          held.clear();
          const open =
            purpose === "classify" || purpose === "select_repository"
              ? options.helpers.open(sessionId)
              : null;
          if (open?.purpose === purpose && open.prompt === input.prompt) {
            command = open;
            placed = open.account ? { ...open.account, named: true } : undefined;
            break;
          }
          if (open) {
            held.add(open.runnerId);
            slotBusy = true;
          }
          let runners: readonly PlacementCandidate[] = [];
          if (!open)
            runners = options.placement
              ? await options.placement.candidates({
                  ...request,
                  onRejected: (runnerId, reason, until) => {
                    // Other people's runners are not this task's to name.
                    if (NOT_THIS_TASKS.has(reason)) return;
                    note(runnerId, reason.replaceAll("-", " "));
                    if (AT_CAPACITY.test(reason)) {
                      slotBusy = true;
                      if (
                        runnerHelperAvailability(
                          options.db,
                          runnerId,
                          now(),
                          purpose !== "finding_groups",
                        ).held
                      )
                        held.add(runnerId);
                      return;
                    }
                    if (reason === "agent quota cooldown") cooling.push(runnerId);
                    if (until !== undefined && until > now()) checks.push({ runnerId, until });
                  },
                })
              : await store.run((q) => recentRunnersSteps(q, now() - 60_000));
          for (const runner of runners) {
            if (
              excluded.includes(runner.id) ||
              (runner.account && excluded.includes(runner.account.bindingId))
            )
              continue;
            if (purpose === "finding_groups") {
              if (
                !versionAtLeast(
                  await store.run((q) => runnerHostVersionSteps(q, runner.id)),
                  FINDING_GROUPS_RUNNER_VERSION,
                )
              ) {
                note(runner.id, "runner version too old");
                continue;
              }
              const owner = await store.run((q) => runnerOwnerSteps(q, runner.id));
              const clientId = await store.run((q) => linearSessionClientIdSteps(q, sessionId));
              if (
                !owner ||
                !clientId ||
                !workspaceSessionIds(
                  options.db,
                  owner.workspaceId,
                  owner.userId,
                  clientId,
                ).includes(sessionId)
              )
                continue;
            }
            try {
              placed = runner.account;
              command = await store.transaction(() =>
                syncSteps(() => {
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
                    role: input.role,
                    purpose: "helper",
                    startedAt: now(),
                  });
                  return dispatched;
                }),
              );
              break;
            } catch (caughtError1) {
              const busy = caughtError1 instanceof RunnerHelperBusyError ? caughtError1 : null;
              if (busy) slotBusy = true;
              if (busy?.heldRunnerId) held.add(busy.heldRunnerId);
              else journalCaught(caughtError1, "helpers.forSession.immediate", null);
              // A dispatch that fails for any other reason is a cause the message must name.
              note(
                runner.id,
                busy
                  ? "helper lane busy"
                  : caughtError1 instanceof Error
                    ? caughtError1.message
                    : String(caughtError1),
              );
            }
          }
          if (command) break;
          if (purpose !== "finding_groups") for (const runnerId of held) noteHeld(runnerId);
          if (slotBusy && now() >= waitUntil) throw new RunnerSlotsBusyError(HELPER_LANE_BUSY);
          if (!slotBusy) {
            const runnerCooldown = await earliestCooldown(cooling, profile.agent);
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
            const named = new Map<string, Set<string>>();
            for (const [runnerId, why] of reasons) {
              const name = (await store.run((q) => getRunnerSteps(q, runnerId)))?.name ?? runnerId;
              named.set(name, new Set([...(named.get(name) ?? []), ...why]));
            }
            throw new UserFacingError(noRunnerMessage(profile.agent, named));
          }
          await delay(options.pollIntervalMs ?? 250, undefined, { signal: input.signal });
        }
        let accounted = false;
        const deadline = Math.min(command.expiresAt, now() + (input.timeoutMs ?? 60_000));
        waiters.set(command.id, (waiters.get(command.id) ?? 0) + 1);
        try {
          while (now() < deadline) {
            input.signal?.throwIfAborted();
            let result: RunnerHelperResult | null;
            try {
              result = await options.helpers.result(command.id);
            } catch (error) {
              if (now() < deadline) throw error;
              break;
            }
            if (result) {
              const disposition = await store.transaction(() =>
                syncSteps(() =>
                  options.placement?.finished({
                    commandId: command!.id,
                    runnerId: command!.runnerId,
                    profile,
                    result,
                    finishedAt: now(),
                  }),
                ),
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
                  placed?.named && !result.authRequired ? disposition.usageLimit : undefined,
                  false,
                  false,
                  placed?.named ? placed.bindingId : undefined,
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
                await options.helpers.current(command.id);
                appendFileSync(
                  transcript,
                  `${JSON.stringify({ t: new Date(now()).toISOString(), event })}\n`,
                  { mode: 0o600 },
                );
                await input.onEvent?.(event);
              }
              input.signal?.throwIfAborted();
              await options.helpers.current(command.id);
              return { ...result, transcriptPath: transcript };
            }
            await delay(options.pollIntervalMs ?? 250, undefined, { signal: input.signal });
          }
          if (purpose !== "finding_groups" && !(await options.helpers.acknowledged(command.id)))
            throw new RunnerSlotsBusyError(HELPER_LANE_BUSY);
          throw new Error("Remote session helper timed out");
        } finally {
          const others = (waiters.get(command.id) ?? 1) - 1;
          if (others > 0) waiters.set(command.id, others);
          else waiters.delete(command.id);
          // A locally aborted or expired helper is not evidence of a lost runner heartbeat.
          // Cleanup failures must not replace the original timeout, fence or cancellation error.
          try {
            if (!accounted && others === 0)
              await store.transaction(() =>
                syncSteps(() =>
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
                ),
              );
          } catch (error) {
            journalCaught(error, "helpers.forSession.accountingCleanup", null);
          }
          try {
            if (others === 0) options.helpers.finish(command.id);
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
