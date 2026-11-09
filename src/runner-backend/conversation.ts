import type { Database } from "bun:sqlite";
import { runnerConversationLane, unfinishedConversationHelpers } from "../db";
import { journalCaught } from "../journal";
import type { RunnerHelpers } from "../runner-helpers";
import {
  RunnerHelperResultSchema,
  type RunnerHelperResult,
  type RunnerProfile,
} from "../runner-protocol";

type Holder = {
  runnerId: string;
  agent: string;
  sessionId: string;
  runId: string;
  model: string | null;
  account?: { accountId: string; bindingId: string };
};

export type ConversationTurn = {
  commandId: string;
  sessionId: string;
  result: RunnerHelperResult | null;
  expired: boolean;
};

export function conversationTurns(options: {
  db: Database;
  helpers: RunnerHelpers;
  holder: (itemId: string) => Holder | undefined;
  now?: () => number;
}) {
  const { db } = options;
  const now = options.now ?? Date.now;
  return {
    lane(itemId: string): "closed" | "full" | "free" {
      const holder = options.holder(itemId);
      return holder ? runnerConversationLane(db, holder.runnerId, now()) : "closed";
    },
    start(itemId: string, sessionId: string, prompt: string): boolean {
      const holder = options.holder(itemId);
      if (!holder) return false;
      try {
        options.helpers.dispatch({
          runnerId: holder.runnerId,
          sessionId,
          purpose: "conversation",
          profile: { agent: holder.agent as RunnerProfile["agent"], model: holder.model },
          prompt,
          ...(holder.account ? { account: holder.account } : {}),
          conversation: { itemId, runId: holder.runId, resumeSessionId: holder.sessionId },
        });
        return true;
      } catch (error) {
        journalCaught(error, "runner-backend.conversation.start", itemId);
        return false;
      }
    },
    open(itemId: string): ConversationTurn[] {
      return unfinishedConversationHelpers(db).flatMap((row) => {
        const command = JSON.parse(
          Buffer.from(
            (JSON.parse(row.envelope) as { payload: string }).payload,
            "base64url",
          ).toString("utf8"),
        ) as { conversation?: { itemId?: string } };
        if (command.conversation?.itemId !== itemId) return [];
        return [
          {
            commandId: row.id,
            sessionId: row.sessionId,
            result:
              row.result === null ? null : RunnerHelperResultSchema.parse(JSON.parse(row.result)),
            expired: row.expiresAt <= now(),
          },
        ];
      });
    },
    finish(commandId: string): void {
      options.helpers.finish(commandId);
    },
  };
}

export type ConversationTurns = ReturnType<typeof conversationTurns>;
