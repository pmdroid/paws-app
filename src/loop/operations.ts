import type { Database } from "bun:sqlite";
import {
  applyWorkItemEvent,
  getWorkItem,
  restartDecisionQuestion,
  bindRestartDecisionQuestion,
  immediate,
  saveCheckpoint,
  type WorkItemRecord,
  restart as restartItem,
} from "../db";
import {
  ask as openQuestion,
  getQuestion,
  cancelQuestion,
  type Asked,
  type QuestionAsker,
  type StoredQuestion,
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
    // A delivery retried after a crash adopts the stored decision instead of asking twice.
    if (args[2]?.reason === "restart") {
      const existing = restartDecisionQuestion(db, item);
      // Retire older or stale-run copies before routing the next Linear reply.
      const duplicates = db
        .query<{ id: string }, [string, string, string]>(
          `SELECT id FROM question WHERE item_id=? AND session_id=? AND reason='restart'
          AND id<>? AND status IN ('open','queued') AND cancelled_at IS NULL`,
        )
        .all(item.id, owner.sessionId, existing?.id ?? "");
      for (const duplicate of duplicates) cancelQuestion(db, duplicate.id, args[2]?.now);
      if (existing) {
        bindRestartDecisionQuestion(db, item, existing.id);
        const question = getQuestion(db, existing.id)!;
        return { status: question.status === "queued" ? "queued" : "asked", question };
      }
    }
    const result = openQuestion(db, owner, ...args);
    if (args[2]?.reason === "restart") bindRestartDecisionQuestion(db, item, result.question.id);
    if (!pending && !workspace)
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
