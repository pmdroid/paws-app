import { setTimeout as delay } from "node:timers/promises";
import {
  insertRunnerExecutionUsageSteps,
  listRunnersSteps,
  runnerConversationLaneSteps,
  runnerStandingSteps,
  type Db,
  type Q,
  type Steps,
} from "../db";
import { journalCaught } from "../journal";
import {
  RUNNER_SLACK_REPLY_PROMPT_BYTES,
  type HostToolDefinitions,
  type RunnerCodingAgent,
  type RunnerHelperResult,
  type RunnerSlackReplyScope,
} from "../runner-protocol";
import {
  RUNNER_ONLINE_MS,
  signInFitSteps,
  type PlacementAccount,
  type RunnerPlacement,
} from "../runner-placement";
import {
  HelperFencedError,
  RunnerHelperBusyError,
  type HelperRepositoryHandler,
  type HelperToolHandler,
  type RunnerHelpers,
} from "../runner-helpers";

export const SLACK_REPLY_ATTEMPTS = 2;
export const SLACK_REPLY_TEXT_LIMIT = 12_000;
const SLACK_REPLY_NOTES_LIMIT = 20_000;

function replyFits(text: string): boolean {
  const at = text.indexOf("```paws-notes");
  const answer = at < 0 ? text : text.slice(0, at).trimEnd();
  const notes = at < 0 ? "" : text.slice(at);
  return answer.length <= SLACK_REPLY_TEXT_LIMIT && notes.length <= SLACK_REPLY_NOTES_LIMIT;
}

export type SlackReplyRequest = {
  workspaceId: string;
  scope: RunnerSlackReplyScope;
  profile: { agent: RunnerCodingAgent; model: string | null };
  prompt: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  tools?: { definitions: HostToolDefinitions; call: HelperToolHandler };
  repositories?: HelperRepositoryHandler;
  attached?: string[];
};

export type SlackReplyOutcome =
  | {
      status: "answered";
      commandId: string;
      runnerId: string;
      scope: RunnerSlackReplyScope;
      text: string;
    }
  | { status: "busy" }
  | { status: "refused"; reason: string }
  | { status: "fenced" }
  | { status: "timed_out" }
  | { status: "failed"; reason: string };

export function createSlackReplies(options: {
  store: Db;
  helpers: RunnerHelpers;
  placement: Pick<RunnerPlacement, "finishedSteps">;
  now?: () => number;
  pollIntervalMs?: number;
}) {
  const { store, helpers } = options;
  const now = options.now ?? Date.now;
  const poll = options.pollIntervalMs ?? 250;

  function* candidatesSteps(
    q: Q,
    request: SlackReplyRequest,
    excluded: ReadonlySet<string>,
  ): Steps<{ runnerId: string; account?: PlacementAccount }[]> {
    const at = now();
    const found: { runnerId: string; account?: PlacementAccount }[] = [];
    for (const runner of yield* listRunnersSteps(q, request.workspaceId)) {
      if (
        excluded.has(runner.id) ||
        runner.ownerUserId !== request.scope.memberUserId ||
        runner.status !== "active"
      )
        continue;
      const standing = yield* runnerStandingSteps(q, runner.id);
      if (!standing?.lastSeenAt || standing.lastSeenAt <= at - RUNNER_ONLINE_MS) continue;
      if ((yield* runnerConversationLaneSteps(q, runner.id, at)) === "closed") continue;
      const fit = yield* signInFitSteps(q, runner, request.workspaceId, {
        agent: request.profile.agent,
        model: request.profile.model,
        purpose: "helper",
        role: "implementer",
        at,
      });
      if (!("reason" in fit)) found.push({ runnerId: runner.id, account: fit.account });
    }
    return found;
  }

  async function send(request: SlackReplyRequest, excluded: ReadonlySet<string>) {
    const candidates = await store.run((q) => candidatesSteps(q, request, excluded));
    let busy = false;
    for (const candidate of candidates) {
      try {
        const command = await store.transaction(function* (q) {
          const { command: dispatched } = yield* helpers.dispatchSteps(q, {
            runnerId: candidate.runnerId,
            sessionId: request.scope.requestId,
            purpose: "slack_reply",
            profile: request.profile,
            prompt: request.prompt,
            slack: request.scope,
            ...(request.tools ? { tools: request.tools.definitions } : {}),
            ...(request.attached ? { repositories: request.attached } : {}),
            ...(candidate.account
              ? {
                  account: {
                    accountId: candidate.account.accountId,
                    bindingId: candidate.account.bindingId,
                  },
                }
              : {}),
          });
          yield* insertRunnerExecutionUsageSteps(q, {
            commandId: dispatched.id,
            runnerId: dispatched.runnerId,
            ownerUserId: request.scope.memberUserId,
            itemId: null,
            runId: null,
            agent: request.profile.agent,
            model: request.profile.model,
            role: "implementer",
            purpose: "helper",
            startedAt: now(),
            placementReason: null,
          });
          return dispatched;
        });
        return { command };
      } catch (error) {
        if (error instanceof RunnerHelperBusyError) busy = true;
        else journalCaught(error, "runner-helpers.slack-reply.dispatch", null);
      }
    }
    return { busy };
  }

  async function wait(
    request: SlackReplyRequest,
    commandId: string,
    deadline: number,
  ): Promise<RunnerHelperResult | "fenced" | "timed_out"> {
    while (now() < deadline) {
      request.signal?.throwIfAborted();
      try {
        const result = await helpers.result(commandId);
        if (result) return result;
      } catch (error) {
        if (error instanceof HelperFencedError) return now() < deadline ? "fenced" : "timed_out";
        throw error;
      }
      await delay(poll, undefined, { signal: request.signal });
    }
    return "timed_out";
  }

  return {
    async reply(request: SlackReplyRequest): Promise<SlackReplyOutcome> {
      if (Buffer.byteLength(request.prompt) > RUNNER_SLACK_REPLY_PROMPT_BYTES)
        return { status: "refused", reason: "The Slack thread context is too large." };
      const excluded = new Set<string>();
      let last: SlackReplyOutcome = {
        status: "refused",
        reason: "No runner of the Paws member can answer in Slack right now.",
      };
      for (let attempt = 0; attempt < SLACK_REPLY_ATTEMPTS; attempt++) {
        const sent = await send(request, excluded);
        if (!sent.command) return sent.busy && attempt === 0 ? { status: "busy" } : last;
        const { command } = sent;
        excluded.add(command.runnerId);
        const tools = request.tools;
        const unhandle =
          tools || request.repositories
            ? helpers.handle(
                command.id,
                tools && ((name, args) => tools.call(name, args)),
                request.repositories,
              )
            : () => undefined;
        let settled: RunnerHelperResult | "timeout" | "error" = "error";
        try {
          const deadline = Math.min(command.expiresAt, now() + (request.timeoutMs ?? Infinity));
          const result = await wait(request, command.id, deadline);
          if (result === "fenced") return { status: result };
          if (result === "timed_out") {
            settled = "timeout";
            return { status: result };
          }
          settled = result;
          if (
            result.commandId !== command.id ||
            command.slack?.requestId !== request.scope.requestId
          )
            return { status: "failed", reason: "The runner answered another request." };
          if (result.replies || result.startWork)
            return { status: "failed", reason: "The runner answered with a tool it may not use." };
          const text = result.text.trim();
          if (
            !result.errorMessage &&
            !result.cancelled &&
            !result.timedOut &&
            !result.authRequired &&
            result.stopReason === "end_turn" &&
            text
          ) {
            if (!replyFits(text))
              return { status: "failed", reason: "The answer is too long for a Slack reply." };
            return {
              status: "answered",
              commandId: command.id,
              runnerId: command.runnerId,
              scope: command.slack,
              text,
            };
          }
          if (result.timedOut) return { status: "timed_out" };
          last = {
            status: "failed",
            reason: result.authRequired
              ? "The runner agent requires sign-in."
              : (result.errorMessage ?? "The runner agent did not answer."),
          };
          if (result.cancelled || !result.agentExited) return last;
        } finally {
          unhandle();
          await store
            .transaction((q) =>
              options.placement.finishedSteps(q, {
                commandId: command.id,
                runnerId: command.runnerId,
                profile: request.profile,
                ...(typeof settled === "string" ? { failure: settled } : { result: settled }),
                finishedAt: now(),
              }),
            )
            .catch((error: unknown) => {
              journalCaught(error, "runner-helpers.slack-reply.settle", null);
            });
          await helpers.finish(command.id).catch((error: unknown) => {
            journalCaught(error, "runner-helpers.slack-reply.finish", null);
          });
        }
      }
      return last;
    },
  };
}

export type SlackReplies = ReturnType<typeof createSlackReplies>;
