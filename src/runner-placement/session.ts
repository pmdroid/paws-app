import {
  getWorkItemSteps,
  itemSessionResultsSteps,
  runPlacementCommandSteps,
  legacyAgentBindingId,
  inMergeQueueSteps,
  restartedFromMergeQueueSteps,
  type Q,
  type Steps,
} from "../db";
import type { RunnerCodingAgent } from "../runner-protocol";
import { quotaSignal } from "../core";
type SessionHolder = {
  runnerId: string;
  agent: string;
  sessionId: string;
  bindingId: string;
  runId: string;
  model: string | null;
  account?: { accountId: string; bindingId: string };
};

/** The runner and agent holding the item's last resumable session. */
export function* sessionHolderSteps(q: Q, itemId: string): Steps<SessionHolder | undefined> {
  const rows = yield* itemSessionResultsSteps(q, itemId);
  for (const row of rows) {
    const command = JSON.parse(
      Buffer.from((JSON.parse(row.envelope) as { payload: string }).payload, "base64url").toString(
        "utf8",
      ),
    ) as {
      runnerId?: string;
      runId?: string;
      checkpoint?: boolean;
      profile?: { agent?: string; model?: string | null };
      account?: { accountId: string; bindingId: string };
    };
    if (command.checkpoint === false) continue;
    const result = JSON.parse(row.payload) as {
      stopReason?: string;
      sessionId?: string;
      errorMessage?: string;
    };
    // An errored session may hold the prompt that failed; a usage-limit stop does not.
    const resumable =
      result.stopReason !== "error" ||
      (result.errorMessage !== undefined &&
        quotaSignal(result.errorMessage, row.receivedAt)?.state === "exhausted");
    return command.runnerId &&
      command.runId &&
      command.profile?.agent &&
      resumable &&
      result.sessionId
      ? {
          runnerId: command.runnerId,
          agent: command.profile.agent,
          sessionId: result.sessionId,
          bindingId:
            command.account?.bindingId ??
            legacyAgentBindingId(command.runnerId, command.profile.agent as RunnerCodingAgent),
          runId: command.runId,
          model: command.profile.model ?? null,
          ...(command.account ? { account: command.account } : {}),
        }
      : undefined;
  }
  return undefined;
}

/**
 * Where a command for the run goes. A turn that continues the agent session is pinned to the
 * run's runner. Merge-queue work that continues no session, such as a re-verify's checks and
 * review, is not pinned: it prefers the run's runner and takes any eligible one. So when such
 * work last ran on another runner, the merge-queue item's next turn is pinned to the runner
 * holding its session. A run that moved because its runner went away keeps its new runner.
 */
export function* runRunnerSteps(
  q: Q,
  input: { itemId: string; runId: string; continuesSession: boolean; sessionRunnerId?: string },
): Steps<{ pinnedRunnerId?: string; preferRunnerId?: string }> {
  const row = yield* runPlacementCommandSteps(q, input.runId);
  if (!row) return {};
  const merging = yield* inMergeQueueSteps(q, input.itemId);
  if (!input.continuesSession && merging) return { preferRunnerId: row.runnerId };
  const backToSession =
    input.continuesSession &&
    input.sessionRunnerId !== undefined &&
    (merging || (yield* restartedFromMergeQueueSteps(q, input.itemId))) &&
    (row.kind === "review" ||
      (row.kind === "run" &&
        row.envelope !== null &&
        (
          JSON.parse(
            Buffer.from(
              (JSON.parse(row.envelope) as { payload: string }).payload,
              "base64url",
            ).toString("utf8"),
          ) as { checkpoint?: boolean }
        ).checkpoint === false));
  return { pinnedRunnerId: backToSession ? input.sessionRunnerId : row.runnerId };
}

export function* itemWorkPlacementSteps(q: Q, itemId: string, agent: string) {
  const holder = yield* sessionHolderSteps(q, itemId);
  const session =
    holder?.agent === agent
      ? { runnerId: holder.runnerId, bindingId: holder.bindingId }
      : undefined;
  const runId = (yield* getWorkItemSteps(q, itemId))?.currentRunId;
  return {
    ...(runId
      ? yield* runRunnerSteps(q, {
          itemId,
          runId,
          continuesSession: true,
          ...(session ? { sessionRunnerId: session.runnerId } : {}),
        })
      : {}),
    ...(session ? { session } : {}),
  };
}
