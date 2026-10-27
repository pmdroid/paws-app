import { journalCaught } from "../journal";
import {
  DEFAULT_RUN_TIMEOUT_MS,
  recoverAcpConversation,
  type RunAgentOptions,
  type RunAgentResult,
} from "../acp";

export class RetryableRunnerError extends Error {
  override readonly name = "RetryableRunnerError";
  constructor(
    readonly runnerId: string,
    message: string,
    readonly transcriptPath?: string,
    readonly publishedEffects = false,
    readonly usageLimit?: { resetsAt: number | null },
    readonly restarted = false,
    /** The runner stopped the session at a safe point so another runner continues it. */
    readonly handedOver = false,
  ) {
    super(message);
  }
}

/** Paws continues a minute after the reset, or tries again every 15 minutes without one. */
export const USAGE_LIMIT_RESUME_SLACK_MS = 60_000;
export const USAGE_LIMIT_RETRY_MS = 15 * 60_000;

/** No runner can take the work until the agent's usage limit resets. */
export class UsageLimitPause extends Error {
  override readonly name = "UsageLimitPause";
  constructor(
    readonly agent: string,
    readonly resumeAt: number,
    readonly resetsAt: number | null,
    readonly runnerId: string | null,
  ) {
    super(
      `${agent} reached its usage limit${resetsAt === null ? "" : ` until ${new Date(resetsAt).toISOString()}`}`,
    );
  }
}

/** Usage-limit responses and waits share this budget across the whole failover call. */
export const MAX_USAGE_LIMIT_EVENTS = 3;

export class UsageLimitExhaustedError extends Error {
  override readonly name = "UsageLimitExhaustedError";
  constructor(
    readonly runnerId: string | null,
    cause: UsageLimitPause | RetryableRunnerError,
  ) {
    super(`Runner usage-limit retry budget exhausted after ${MAX_USAGE_LIMIT_EVENTS} events`, {
      cause,
    });
  }
}

export type UsageLimit = { runnerId: string; resetsAt: number | null; resumeAt: number };

export type FailoverAttempt = (
  input: RunAgentOptions,
  excluded: readonly string[],
  limit?: UsageLimit,
) => Promise<RunAgentResult>;

/** Waits out a usage limit. It returns at the resume time or throws when the run stops. */
export type UsageLimitWait = {
  now(): number;
  pause(limit: UsageLimitPause): Promise<void>;
};

export async function runWithFailover(
  input: RunAgentOptions,
  attempt: FailoverAttempt,
  settle: (error: RetryableRunnerError) => Promise<void>,
  usageLimits?: UsageLimitWait,
): Promise<RunAgentResult> {
  const excluded: string[] = [];
  let prompt = input.prompt;
  let basePrompt = prompt;
  let deadline = performance.now() + (input.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
  let limit: UsageLimit | undefined;
  let usageLimitEvents = 0;
  const limitedSincePause = new Set<string>();
  for (let index = 0; index < 3;) {
    input.signal?.throwIfAborted();
    try {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) throw new Error("Remote runner request timed out during failover");
      return await attempt({ ...input, prompt, timeoutMs: remaining }, excluded, limit);
    } catch (error) {
      if (error instanceof UsageLimitPause && usageLimits) {
        if (++usageLimitEvents >= MAX_USAGE_LIMIT_EVENTS)
          throw new UsageLimitExhaustedError(error.runnerId, error);
        // Waiting does not consume execution time, but does consume the usage-limit budget.
        const waitingAt = performance.now();
        await usageLimits.pause(error);
        limitedSincePause.clear();
        input.signal?.throwIfAborted();
        deadline += performance.now() - waitingAt;
        limit = undefined;
        journalCaught(
          error,
          "failover.runWithFailover.pause",
          input.itemId,
          "waiting for usage reset",
        );
        continue;
      }
      if (!(error instanceof RetryableRunnerError)) throw error;
      input.signal?.throwIfAborted();
      await settle(error);
      input.signal?.throwIfAborted();
      const usageLimit = usageLimits ? error.usageLimit : undefined;
      if ((!usageLimit && !error.handedOver && index === 2) || performance.now() >= deadline)
        throw error;
      if (
        usageLimit &&
        limitedSincePause.has(error.runnerId) &&
        ++usageLimitEvents >= MAX_USAGE_LIMIT_EVENTS
      )
        throw new UsageLimitExhaustedError(error.runnerId, error);
      if (usageLimit) limitedSincePause.add(error.runnerId);
      if (usageLimit)
        // The runner stays eligible: its cooldown keeps it out until the reset, and another
        // runner with an available account can take the work meanwhile.
        limit = {
          runnerId: error.runnerId,
          resetsAt: usageLimit.resetsAt,
          resumeAt:
            usageLimit.resetsAt === null
              ? usageLimits!.now() + USAGE_LIMIT_RETRY_MS
              : usageLimit.resetsAt + USAGE_LIMIT_RESUME_SLACK_MS,
        };
      else if (error.handedOver) {
        // A handover is not a failure: it spends no attempt, and the old runner stays out.
        if (!excluded.includes(error.runnerId)) excluded.push(error.runnerId);
      } else {
        index++;
        if (!error.restarted) excluded.push(error.runnerId);
      }
      let approved = "";
      if (error.publishedEffects) {
        if (!input.askTeam)
          throw new Error(
            "The interrupted runner published an artifact or asked a question. Review the existing result before continuing.",
            { cause: error },
          );
        const waitingAt = performance.now();
        const answer = await input.askTeam.ask(
          {
            question:
              "The runner stopped after publishing an artifact or asking a question. Review the existing result and reply with instructions to continue.",
          },
          {
            itemId: input.itemId,
            runId: input.runId,
            role: input.role,
            signal: input.signal ?? new AbortController().signal,
          },
        );
        input.signal?.throwIfAborted();
        deadline += performance.now() - waitingAt;
        approved = answer.answer;
      }
      const history = error.transcriptPath
        ? await recoverAcpConversation(error.transcriptPath).catch(
            (failure: NodeJS.ErrnoException) => {
              if (failure.code === "ENOENT") {
                journalCaught(
                  failure,
                  "failover.runWithFailover.recoverAcpConversation",
                  input.itemId,
                  "optional file may be absent",
                );
                return [];
              }
              throw failure;
            },
          )
        : [];
      journalCaught(
        error,
        "failover.runWithFailover.floor",
        input.itemId,
        "retrying runner failure",
      );
      if (usageLimit) {
        // The run's transcript holds every earlier attempt, so each limit rebuilds from the base.
        if (approved) basePrompt = `${basePrompt}\n\nContinuation instructions:\n${approved}`;
        prompt = [
          basePrompt,
          "The agent stopped at its usage limit. Continue the same task from where it stopped.",
          history.length ? `Observed prior conversation:\n${JSON.stringify(history)}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        continue;
      }
      prompt = [
        prompt,
        // A handed-over session may be restored on the new runner, so it is not always fresh.
        error.handedOver ? "" : "Continue in a fresh agent session.",
        error.message,
        history.length ? `Observed prior conversation:\n${JSON.stringify(history)}` : "",
        approved ? `Continuation instructions:\n${approved}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      basePrompt = prompt;
    }
  }
  throw new Error("Runner failover exhausted");
}
