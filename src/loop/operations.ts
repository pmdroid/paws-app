import {
  applyWorkItemEventSteps,
  getWorkItemSteps,
  saveCheckpointSteps,
  type Q,
  type Steps,
  type WorkItemRecord,
  restart as restartItem,
} from "../db";
import {
  askSteps as openQuestionSteps,
  type Asked,
  type QuestionAsker,
  type StoredQuestion,
} from "../questions";

export { halt, restartSteps, type RestartHandoff } from "../db";

/**
 * Open or queue one question and record why this item needs a person.
 * `pending` asks for a pending-human check inside `verifying`: the item keeps
 * its state while the other checks run, and enters `awaiting_input` through
 * {@link awaitQuestionSteps} once they are done. `workspace` asks about the workspace,
 * not the item: the question goes to the item's session and the item keeps its state.
 */
type Asker = QuestionAsker & { pending?: boolean; workspace?: boolean };
type AskArgs =
  Parameters<typeof openQuestionSteps> extends [unknown, unknown, ...infer Rest] ? Rest : never;

export function* askSteps(q: Q, asker: Asker, ...args: AskArgs): Steps<Asked> {
  const { pending, workspace, ...owner } = asker;
  const item = yield* getWorkItemSteps(q, owner.itemId);
  if (
    !item ||
    item.cancelRequested ||
    owner.sessionId !== item.sessionKey ||
    (owner.runId !== null && owner.runId !== item.currentRunId) ||
    (owner.version !== undefined && owner.version !== item.version) ||
    (pending && item.state !== "verifying")
  )
    throw new Error("Question owner is stale");
  const result = yield* openQuestionSteps(q, owner, ...args);
  if (!pending && !workspace)
    yield* awaitQuestionSteps(q, item, result.question, args[2]?.now ?? Date.now());
  return result;
}

export function restart(...args: Parameters<typeof restartItem>): ReturnType<typeof restartItem> {
  return restartItem(...args);
}

export function* awaitQuestionSteps(
  q: Q,
  item: WorkItemRecord,
  question: StoredQuestion,
  now: number,
): Steps<void> {
  yield* applyWorkItemEventSteps(q, item.id, "blocking_question", {
    kind: "ask",
    reason: question.reason,
    payloadDigest: question.id,
    now,
  });
  if (item.checkpoint)
    yield* saveCheckpointSteps(q, item.id, { ...item.checkpoint, phase: "awaiting_input" });
}
