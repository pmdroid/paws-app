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
    /** The agent session that stopped, when the runner reported it. */
    readonly sessionId?: string,
  ) {
    super(message);
  }
}

/**
 * Where work stopped at a usage limit continues. On `runnerId` the attempt
 * resumes `sessionId`. Another runner starts a fresh session from the
 * transcript, and asks the team first through `confirmElsewhere` when the
 * stopped session already published an artifact or asked a question.
 */
export type UsageContinuation = {
  runnerId: string;
  sessionId?: string;
  confirmElsewhere?: () => Promise<string>;
};

const PUBLISHED_EFFECTS_QUESTION =
  "The runner stopped after publishing an artifact or asking a question. Review the existing result and reply with instructions to continue on another runner.";

export async function runWithFailover(
  input: RunAgentOptions,
  attempt: (
    input: RunAgentOptions,
    excluded: readonly string[],
    continuation?: UsageContinuation,
  ) => Promise<RunAgentResult>,
  settle: (error: RetryableRunnerError) => Promise<void>,
): Promise<RunAgentResult> {
  const excluded: string[] = [];
  let prompt = input.prompt;
  const timeout = input.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  let deadline = performance.now() + timeout;
  let continuation: UsageContinuation | undefined;
  let published = false;
  const approve = async (cause: RetryableRunnerError) => {
    if (!input.askTeam)
      throw new Error(
        "The interrupted runner published an artifact or asked a question. Review the existing result before continuing.",
        { cause },
      );
    const answer = await input.askTeam.ask(
      { question: PUBLISHED_EFFECTS_QUESTION },
      {
        itemId: input.itemId,
        runId: input.runId,
        role: input.role,
        signal: input.signal ?? new AbortController().signal,
      },
    );
    input.signal?.throwIfAborted();
    published = false;
    return answer.answer;
  };
  for (let index = 0; index < 3;) {
    input.signal?.throwIfAborted();
    try {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) throw new Error("Remote runner request timed out during failover");
      return await attempt({ ...input, prompt, timeoutMs: remaining }, excluded, continuation);
    } catch (error) {
      if (!(error instanceof RetryableRunnerError)) throw error;
      input.signal?.throwIfAborted();
      await settle(error);
      input.signal?.throwIfAborted();
      published ||= error.publishedEffects;
      let approved = "";
      if (error.usageLimit) {
        deadline = performance.now() + timeout;
        // The same session continues without a question; only a move to another runner asks.
        continuation = {
          runnerId: error.runnerId,
          ...(error.sessionId
            ? { sessionId: error.sessionId }
            : continuation?.runnerId === error.runnerId && continuation.sessionId
              ? { sessionId: continuation.sessionId }
              : {}),
          ...(published ? { confirmElsewhere: () => approve(error) } : {}),
        };
      } else {
        continuation = undefined;
        index++;
        if (index === 3 || performance.now() >= deadline) throw error;
        excluded.push(error.runnerId);
        if (published) {
          const waitingAt = performance.now();
          approved = await approve(error);
          deadline += performance.now() - waitingAt;
        }
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
