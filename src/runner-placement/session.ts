import type { Database } from "bun:sqlite";
import {
  getWorkItem,
  itemSessionResults,
  runPlacementCommand,
  legacyAgentBindingId,
  inMergeQueue,
  restartedFromMergeQueue,
} from "../db";
import type { RunnerCodingAgent } from "../runner-protocol";
import { quotaSignal } from "./quota";
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
export function sessionHolder(db: Database, itemId: string): SessionHolder | undefined {
  const rows = itemSessionResults(db, itemId);
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
export function runRunner(
  db: Database,
  input: { itemId: string; runId: string; continuesSession: boolean; sessionRunnerId?: string },
): { pinnedRunnerId?: string; preferRunnerId?: string } {
  const row = runPlacementCommand(db, input.runId);
  if (!row) return {};
  const merging = inMergeQueue(db, input.itemId);
  if (!input.continuesSession && merging) return { preferRunnerId: row.runnerId };
  const backToSession =
    input.continuesSession &&
    input.sessionRunnerId !== undefined &&
    (merging || restartedFromMergeQueue(db, input.itemId)) &&
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

export function itemWorkPlacement(db: Database, itemId: string, agent: string) {
  const holder = sessionHolder(db, itemId);
  const session =
    holder?.agent === agent
      ? { runnerId: holder.runnerId, bindingId: holder.bindingId }
      : undefined;
  const runId = getWorkItem(db, itemId)?.currentRunId;
  return {
    ...(runId
      ? runRunner(db, {
          itemId,
          runId,
          continuesSession: true,
          ...(session ? { sessionRunnerId: session.runnerId } : {}),
        })
      : {}),
    ...(session ? { session } : {}),
  };
}
