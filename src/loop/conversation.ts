import { journalCaught } from "../journal";
import { stat } from "node:fs/promises";
import {
  AcpCleanupError,
  createAcpPromptLifecycle,
  recoverAcpConversation,
  runDir,
  type AcpConversationEntry,
  type RunAgentOptions,
  type RunAgentResult,
} from "../acp";
import { getConversationSteps, saveConversationSteps, type Db } from "../db";

export async function durableConversation(
  store: Db,
  itemId: string,
  runner?: (options: RunAgentOptions) => Promise<RunAgentResult>,
) {
  const stored = await store.run((q) => getConversationSteps(q, itemId));
  if (stored.blocked) throw new AcpCleanupError("Prior ACP process cleanup could not be verified");
  const history = JSON.parse(stored.entries) as AcpConversationEntry[];
  if (stored.transcript) {
    try {
      history.push(...(await recoverAcpConversation(stored.transcript, stored.transcriptOffset)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      journalCaught(
        error,
        "conversation.durableConversation.push",
        itemId,
        "optional file may be absent",
      );
    }
    const entries = JSON.stringify(history);
    await store.run((q) => saveConversationSteps(q, itemId, entries, null));
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
          journalCaught(
            error,
            "conversation.durableConversation.stat",
            itemId,
            "optional file may be absent",
          );
          if (error.code === "ENOENT") return 0;
          throw error;
        },
      );
      const entries = JSON.stringify([
        ...lifecycle.snapshot(),
        { kind: "request", body: options.prompt },
      ]);
      await store.run((q) => saveConversationSteps(q, itemId, entries, transcript, false, offset));
      let blocked = false;
      try {
        return await lifecycle.prompt(options);
      } catch (error) {
        blocked = error instanceof AcpCleanupError;
        throw error;
      } finally {
        const finished = JSON.stringify(lifecycle.snapshot());
        await store.run((q) => saveConversationSteps(q, itemId, finished, null, blocked));
      }
    } finally {
      active = false;
    }
  };
}
