import { stat } from "node:fs/promises";
import type { Database } from "bun:sqlite";
import {
  AcpCleanupError,
  createAcpPromptLifecycle,
  recoverAcpConversation,
  runDir,
  type AcpConversationEntry,
  type RunAgentOptions,
  type RunAgentResult,
} from "../acp";
import { getConversation, saveConversation } from "../db";

export async function durableConversation(
  db: Database,
  itemId: string,
  runner?: (options: RunAgentOptions) => Promise<RunAgentResult>,
) {
  const stored = getConversation(db, itemId);
  if (stored.blocked) throw new AcpCleanupError("Prior ACP process cleanup could not be verified");
  const history = JSON.parse(stored.entries) as AcpConversationEntry[];
  if (stored.transcript) {
    try {
      history.push(...(await recoverAcpConversation(stored.transcript, stored.transcriptOffset)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    saveConversation(db, itemId, JSON.stringify(history), null);
  }
  const lifecycle = createAcpPromptLifecycle(history, runner);
  let active = false;
  return async (options: RunAgentOptions): Promise<RunAgentResult> => {
    if (active) throw new Error("ACP prompt already running");
    active = true;
    try {
      const transcript = `${runDir(options.pawsRoot, options.runId)}/acp.jsonl`;
      const offset = await stat(transcript).then(
        (info) => info.size,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return 0;
          throw error;
        },
      );
      saveConversation(
        db,
        itemId,
        JSON.stringify([...lifecycle.snapshot(), { kind: "request", body: options.prompt }]),
        transcript,
        false,
        offset,
      );
      let blocked = false;
      try {
        return await lifecycle.prompt(options);
      } catch (error) {
        blocked = error instanceof AcpCleanupError;
        throw error;
      } finally {
        saveConversation(db, itemId, JSON.stringify(lifecycle.snapshot()), null, blocked);
      }
    } finally {
      active = false;
    }
  };
}
