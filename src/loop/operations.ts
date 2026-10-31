import {
  MAX_ITEM_RESTARTS,
  RESTART_BUDGET_CONTINUE,
  continuesRestartBudget,
  transition,
} from "../core";
import type { Database } from "bun:sqlite";
import {
  applyWorkItemEvent,
  getWorkItem,
  immediate,
  halt,
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
    if (!current || current.version !== item.version) return null;
    const source = handoff.source ?? (handoff.reason === "answer" ? "human" : "agent");
    if (source === "agent" && current.restartCount >= current.restartLimit) {
      // Ask only where the existing state machine permits it, without destructive fallback edges.
      if (
        current.cancelRequested ||
        !current.sessionKey ||
        !transition(current.state, "blocking_question").ok
      )
        return null;
      if (
        db
          .query(
            "SELECT 1 FROM question WHERE item_id=? AND reason='restart_budget' AND status IN ('open','queued') AND cancelled_at IS NULL",
          )
          .get(item.id)
      )
        return null;
      const halted = halt(db, current, handoff.now);
      if (!halted) return null;
      ask(
        db,
        {
          itemId: item.id,
          runId: halted.currentRunId,
          sessionId: current.sessionKey,
          version: halted.version,
        },
        "clarification",
        `Paws used ${current.restartCount} of ${current.restartLimit} lifetime agent restarts. Continue grants ${MAX_ITEM_RESTARTS} more; Stop ends the task.\n\nRequested work:\n${handoff.body}`,
        { reason: "restart_budget", options: [RESTART_BUDGET_CONTINUE, "Stop"], now: handoff.now },
      );
      return null;
    }
    const jobId = restartItem(...args);
    if (jobId === null) return null;
    if (source === "agent")
      db.run("UPDATE work_item SET restart_count=restart_count+1 WHERE id=?", [item.id]);
    else if (source === "human") {
      // An answer grants more only once it is carried into an admitted human turn.
      const answers = db
        .query<{ id: string; answer: string | null }, [string]>(
          "SELECT id,answer FROM question WHERE item_id=? AND reason='restart_budget' AND status='answered' AND cancelled_at IS NULL AND handoff_version IS NULL",
        )
        .all(item.id);
      for (const answer of answers) {
        if (continuesRestartBudget(answer.answer))
          db.run("UPDATE work_item SET restart_limit=restart_limit+? WHERE id=?", [
            MAX_ITEM_RESTARTS,
            item.id,
          ]);
        db.run("UPDATE question SET handoff_version=? WHERE id=?", [
          getWorkItem(db, item.id)!.version,
          answer.id,
        ]);
      }
    }
    return jobId;
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
