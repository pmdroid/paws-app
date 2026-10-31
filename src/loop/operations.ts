import { MAX_ITEM_RESTARTS, RESTART_BUDGET_CONTINUE, transition } from "../core";
import type { Database } from "bun:sqlite";
import {
  applyWorkItemEvent,
  getWorkItem,
  getLinearSession,
  bindLinearSessionTask,
  immediate,
  halt,
  lifetimeRestartBudget,
  budgetHandoffs,
  holdBudgetHandoff,
  restoreBudgetQueue,
  carryBudgetHandoffs,
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
    let current = getWorkItem(db, item.id);
    if (!current || current.version !== item.version) return null;
    const { used, limit } = lifetimeRestartBudget(db, item.id);
    if (used < limit) {
      const held = budgetHandoffs(db, item.id);
      if (held.length === 0) return restartItem(...args);
      const original = held[0]!.handoff;
      const requestedKey = original.jobKey ?? handoff.jobKey;
      // A previous attempt can already own that key; enqueueJobOnce must not return its cancelled job.
      const jobKey =
        requestedKey && db.query("SELECT 1 FROM job WHERE job_key=?").get(requestedKey)
          ? `budget-resume:${item.id}:${held[0]!.id}`
          : requestedKey;
      restoreBudgetQueue(db, item.id, held);
      const body = [...new Set([...held.map((entry) => entry.handoff.body), handoff.body])].join(
        "\n\n",
      );
      const jobId = restartItem(db, current, {
        ...original,
        // A human answer still resets the per-human turn/fix counters, never the lifetime tally.
        reason: handoff.reason === "answer" ? "answer" : original.reason,
        body,
        now: handoff.now,
        jobKey,
        limit: original.limit ?? handoff.limit,
        keepMergeQueuePlace:
          handoff.keepMergeQueuePlace || held.some((entry) => entry.handoff.keepMergeQueuePlace),
      });
      if (jobId !== null) carryBudgetHandoffs(db, held, getWorkItem(db, item.id)!.version);
      return jobId;
    }
    if (current.cancelRequested) return null;
    if (!transition(current.state, "restart").ok) return null;
    if (!current.sessionKey) {
      const sessions = db
        .query<{ sessionId: string }, [string]>(
          "SELECT DISTINCT session_key AS sessionId FROM work_item WHERE delegation_id=? AND session_key IS NOT NULL AND session_key<>''",
        )
        .all(current.delegationId)
        .filter(({ sessionId }) => {
          const session = getLinearSession(db, sessionId);
          return (
            session !== null &&
            session.stoppedAt === null &&
            session.delegationId === current!.delegationId
          );
        });
      if (sessions.length === 1) {
        bindLinearSessionTask(db, sessions[0]!.sessionId, current.delegationId);
        current = getWorkItem(db, item.id)!;
      }
    }
    holdBudgetHandoff(db, current.id, handoff);
    // No channel means no destructive halt and no exception in a caller's shared transaction.
    if (!current.sessionKey) return null;
    const halted = halt(db, current, handoff.now);
    if (!halted) return null;
    const waiting = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM question WHERE item_id=? AND reason='restart_budget' AND status IN ('open','queued') AND cancelled_at IS NULL ORDER BY rowid DESC LIMIT 1",
      )
      .get(item.id);
    if (waiting) {
      if (halted.state !== "awaiting_input")
        awaitQuestion(db, halted, getQuestion(db, waiting.id)!, handoff.now);
    } else {
      ask(
        db,
        {
          itemId: item.id,
          runId: halted.currentRunId,
          sessionId: current.sessionKey,
          version: halted.version,
        },
        "clarification",
        `Paws used ${used} of ${limit} lifetime restarts for this item. Automatic restarts have stopped. Continue grants ${MAX_ITEM_RESTARTS} more restarts; Stop ends the task.`,
        { reason: "restart_budget", options: [RESTART_BUDGET_CONTINUE, "Stop"], now: handoff.now },
      );
    }
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
