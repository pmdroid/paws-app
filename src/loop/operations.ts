import { MAX_ITEM_RESTARTS, transition } from "../core";
import type { Database } from "bun:sqlite";
import {
  applyWorkItemEvent,
  getWorkItem,
  immediate,
  halt,
  lifetimeRestarts,
  saveCheckpoint,
  type WorkItemRecord,
  restart as restartItem,
} from "../db";
import {
  ask as openQuestion,
  type Asked,
  type QuestionAsker,
  type StoredQuestion,
  getQuestion,
} from "../questions";

export { halt, type RestartHandoff } from "../db";

/**
 * Open or queue one question and record why this item needs a person.
 * `pending` asks for a pending-human check inside `verifying`: the item keeps
 * its state while the other checks run, and enters `awaiting_input` through
 * {@link awaitQuestion} once they are done. `workspace` asks about the workspace,
 * not the item: the question goes to the item's session and the item keeps its state.
 */
export function ask(
  db: Database,
  asker: QuestionAsker & { pending?: boolean; workspace?: boolean },
  ...args: Parameters<typeof openQuestion> extends [unknown, unknown, ...infer Rest] ? Rest : never
): Asked {
  return immediate(db, () => {
    const { pending, workspace, ...owner } = asker;
    const item = getWorkItem(db, owner.itemId);
    if (
      !item ||
      item.cancelRequested ||
      owner.sessionId !== item.sessionKey ||
      (owner.runId !== null && owner.runId !== item.currentRunId) ||
      (owner.version !== undefined && owner.version !== item.version) ||
      (pending && item.state !== "verifying")
    )
      throw new Error("Question owner is stale");
    const result = openQuestion(db, owner, ...args);
    if (!pending && !workspace)
      awaitQuestion(db, item, result.question, args[2]?.now ?? Date.now());
    return result;
  });
}

export function restart(...args: Parameters<typeof restartItem>): ReturnType<typeof restartItem> {
  const [db, item, handoff] = args;
  return immediate(db, () => {
    const current = getWorkItem(db, item.id);
    if (!current || current.version !== item.version || current.cancelRequested) return null;
    const used = lifetimeRestarts(db, item.id);
    if (used < MAX_ITEM_RESTARTS) return restartItem(...args);
    if (!transition(current.state, "restart").ok) return null;
    const halted = halt(db, current, handoff.now);
    if (!halted) return null;
    // A delivered or answered budget question still counts. Replays never ask again.
    const asked = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM question WHERE item_id=? AND reason='restart_budget' LIMIT 1",
      )
      .get(item.id);
    if (asked && halted.state !== "awaiting_input")
      awaitQuestion(db, halted, getQuestion(db, asked.id)!, handoff.now);
    if (!asked && halted.sessionKey !== null)
      ask(
        db,
        {
          itemId: item.id,
          runId: halted.currentRunId,
          sessionId: halted.sessionKey,
          version: halted.version,
        },
        "clarification",
        `Paws used ${used} of ${MAX_ITEM_RESTARTS} lifetime restarts for this item. Automatic restarts have stopped. Please review the work and decide how to proceed.`,
        { reason: "restart_budget", now: handoff.now },
      );
    return null;
  });
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
