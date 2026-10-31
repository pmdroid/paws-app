import { createHash } from "node:crypto";
import { isTerminalWorkItemState } from "../core";
import type { Database } from "bun:sqlite";
import {
  applyWorkItemEvent,
  enqueueJobOnce,
  enqueueOutboxOnce,
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

/**
 * Deliver guidance without overriding a newer question or restart. Refused handoffs are
 * durable cancelled jobs, carried by the next accepted restart, with a Linear receipt.
 */
export function restart(...args: Parameters<typeof restartItem>): ReturnType<typeof restartItem> {
  const [db, item, handoff] = args;
  return immediate(db, () => {
    const jobId = restartItem(...args);
    if (jobId !== null) return jobId;
    const current = getWorkItem(db, item.id);
    if (!current) return null;
    const digest = createHash("sha256").update(handoff.body).digest("hex");
    if (current.state === "queued" && !current.cancelRequested) {
      const pending = db
        .query<{ id: number; handoff: string | null }, [string, number]>(
          "SELECT id,json_extract(payload,'$.handoff') AS handoff FROM job WHERE queue='run.resume' AND status='pending' AND json_extract(payload,'$.itemId')=? AND item_version=? ORDER BY id DESC LIMIT 1",
        )
        .get(item.id, current.version);
      if (pending) {
        db.run("UPDATE job SET payload=json_set(payload,'$.handoff',?) WHERE id=?", [
          [pending.handoff, handoff.body].filter(Boolean).join("\n\n"),
          pending.id,
        ]);
        return pending.id;
      }
    }
    if (!isTerminalWorkItemState(current.state)) {
      const deferred = enqueueJobOnce(db, {
        queue: "run.resume",
        jobKey: `deferred:${item.id}:${current.version}:${digest}`,
        payload: { itemId: item.id, handoff: handoff.body, deferredReason: handoff.reason },
        now: handoff.now,
      });
      db.run(
        "UPDATE job SET status='cancelled',last_error='restart_deferred',finished_at=? WHERE id=? AND status='pending'",
        [handoff.now, deferred],
      );
    }
    if (current.sessionKey)
      enqueueOutboxOnce(db, {
        target: "linear",
        op: "activity",
        orderingKey: current.sessionKey,
        idempotencyKey: `restart-deferred:${item.id}:${current.version}:${digest}`,
        payload: {
          sessionId: current.sessionKey,
          kind: "response",
          body: isTerminalWorkItemState(current.state)
            ? `Feedback was saved, but ${current.linearIdentifier} is ${current.state} and was not restarted.\n\n${handoff.body}`
            : `Feedback was saved for ${current.linearIdentifier}'s next restart. The task remains ${current.state}; reply in Linear to retry stopped work.\n\n${handoff.body}`,
        },
        now: handoff.now,
      });
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
