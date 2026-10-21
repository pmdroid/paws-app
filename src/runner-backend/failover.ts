import {
  DEFAULT_RUN_TIMEOUT_MS,
  recoverAcpConversation,
  type RunAgentOptions,
  type RunAgentResult,
} from "../acp";

export class RetryableRunnerError extends Error {
  constructor(
    readonly runnerId: string,
    message: string,
    readonly transcriptPath?: string,
    readonly publishedEffects = false,
    /** The agent reached its usage limit. The runner stays eligible once the limit resets. */
    readonly usageLimit = false,
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
  const timeout = input.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  let deadline = performance.now() + timeout;
  for (let index = 0; index < 3;) {
    input.signal?.throwIfAborted();
    try {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) throw new Error("Remote runner request timed out during failover");
      return await attempt({ ...input, prompt, timeoutMs: remaining }, excluded);
    } catch (error) {
      if (!(error instanceof RetryableRunnerError)) throw error;
      input.signal?.throwIfAborted();
      await settle(error);
      input.signal?.throwIfAborted();
      if (error.usageLimit) deadline = performance.now() + timeout;
      else {
        index++;
        if (index === 3 || performance.now() >= deadline) throw error;
        excluded.push(error.runnerId);
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
        error.usageLimit ? input.prompt : prompt,
        error.usageLimit
          ? "Continue the same task. The previous agent session stopped at its usage limit."
          : "Continue in a fresh agent session on another runner.",
        error.message,
        history.length ? `Observed prior conversation:\n${JSON.stringify(history)}` : "",
        approved ? `Continuation instructions:\n${approved}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
    }
  }
  throw new Error("Runner failover exhausted");
}
