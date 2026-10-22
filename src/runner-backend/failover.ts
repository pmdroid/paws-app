import {
  DEFAULT_RUN_TIMEOUT_MS,
  recoverAcpConversation,
  type RunAgentOptions,
  type RunAgentResult,
} from "../acp";
import { UsageLimitError } from "../core";

export class RetryableRunnerError extends Error {
  constructor(
    readonly runnerId: string,
    message: string,
    readonly transcriptPath?: string,
    readonly publishedEffects = false,
    readonly usageLimit?: { agent: string; resetsAt: number | null; sessionId?: string },
  ) {
    super(message);
  }
}

export async function runWithFailover(
  input: RunAgentOptions,
  attempt: (input: RunAgentOptions, excluded: readonly string[]) => Promise<RunAgentResult>,
  settle: (error: RetryableRunnerError) => Promise<void>,
): Promise<RunAgentResult> {
  const excluded: string[] = [];
  let prompt = input.prompt;
  let limited: { runnerId: string; resetsAt: number | null } | undefined;
  let session = input.runnerSession;
  let deadline = performance.now() + (input.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
  for (let index = 0; index < 3; index++) {
    input.signal?.throwIfAborted();
    try {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) throw new Error("Remote runner request timed out during failover");
      return await attempt(
        { ...input, prompt, timeoutMs: remaining, ...(session ? { runnerSession: session } : {}) },
        excluded,
      );
    } catch (error) {
      // The interrupted conversation and agent session travel with the pause so the resumed run
      // continues them. Placement reports the earliest reset of any eligible account.
      if (error instanceof UsageLimitError && limited)
        throw new UsageLimitError(
          error.agent,
          limited.resetsAt === null || error.resetsAt === null
            ? limited.resetsAt
            : Math.min(limited.resetsAt, error.resetsAt),
          limited.runnerId,
          prompt,
          session,
        );
      if (!(error instanceof RetryableRunnerError)) throw error;
      input.signal?.throwIfAborted();
      await settle(error);
      input.signal?.throwIfAborted();
      if ((index === 2 || performance.now() >= deadline) && !error.usageLimit) throw error;
      // A usage limit puts the account in cooldown instead of excluding its runner, so placement
      // can still choose another runner with an available account, or pause until the reset.
      if (error.usageLimit) {
        limited = { runnerId: error.runnerId, resetsAt: error.usageLimit.resetsAt };
        session = error.usageLimit.sessionId
          ? { runnerId: error.runnerId, sessionId: error.usageLimit.sessionId }
          : undefined;
      } else {
        excluded.push(error.runnerId);
        session = undefined;
      }
      let approved = "";
      // The same task continues after a usage limit with its whole conversation, so artifacts and
      // answers it already published need no review before it goes on.
      if (error.publishedEffects && !error.usageLimit) {
        if (!input.askTeam)
          throw new Error(
            "The interrupted runner published an artifact or asked a question. Review the existing result before continuing.",
            { cause: error },
          );
        const waitingAt = performance.now();
        const answer = await input.askTeam.ask(
          {
            question:
              "The runner stopped after publishing an artifact or asking a question. Review the existing result and reply with instructions to continue on another runner.",
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
              if (failure.code === "ENOENT") return [];
              throw failure;
            },
          )
        : [];
      prompt = [
        prompt,
        error.usageLimit
          ? "The agent stopped at its usage limit. Continue the task where it stopped."
          : "Continue in a fresh agent session on another runner.",
        error.message,
        history.length ? `Observed prior conversation:\n${JSON.stringify(history)}` : "",
        approved ? `Continuation instructions:\n${approved}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      if (error.usageLimit && (index === 2 || performance.now() >= deadline))
        throw new UsageLimitError(
          error.usageLimit.agent,
          error.usageLimit.resetsAt,
          error.runnerId,
          prompt,
          session,
        );
    }
  }
  throw new Error("Runner failover exhausted");
}
