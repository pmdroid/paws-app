import type { Database } from "bun:sqlite";
import {
  applyWorkItemEvent,
  getWorkItem,
  immediate,
  saveCheckpoint,
  type WorkItemRecord,
  restart as restartItem,
} from "../db";
import {
  ask as openQuestion,
  type Asked,
  type QuestionAsker,
  type StoredQuestion,
} from "../questions";

export { halt, type RestartHandoff } from "../db";

/** Open or queue one question and record why this item needs a person. */
export function ask(
  db: Database,
  asker: QuestionAsker & { version?: number },
  ...args: Parameters<typeof openQuestion> extends [unknown, unknown, ...infer Rest] ? Rest : never
): Asked {
  return immediate(db, () => {
    const item = getWorkItem(db, asker.itemId);
    if (
      !item ||
      item.cancelRequested ||
      asker.sessionId !== item.sessionKey ||
      (asker.runId !== null && asker.runId !== item.currentRunId) ||
      (asker.version !== undefined && asker.version !== item.version)
    )
      throw new Error("Question owner is stale");
    const result = openQuestion(db, asker, ...args);
    awaitQuestion(db, item, result.question, args[2]?.now ?? Date.now());
    return result;
  });
}

export function restart(...args: Parameters<typeof restartItem>): ReturnType<typeof restartItem> {
  return restartItem(...args);
}

/** Adopt an already stored question when recovering older in-flight work. */
export function awaitQuestion(
  db: Database,
  item: WorkItemRecord,
  question: StoredQuestion,
  now: number,
): void {
  applyWorkItemEvent(db, item.id, "blocking_question", {
    kind: "ask",
    reason: question.reason,
    payloadDigest: question.id,
    now,
  });
  if (item.checkpoint) saveCheckpoint(db, item.id, { ...item.checkpoint, phase: "awaiting_input" });
}
