import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { type Db, type Q, type Steps } from "./db";
import { JOB_KIND, type Checkpoint, type StartupDecision } from "../core";
import {
  applyWorkItemEventSteps,
  failWorkItemSteps,
  getWorkItemSteps,
  saveCheckpointSteps,
  markResumedSteps,
  type WorkItemRecord,
} from "./items";
import { emitJobReady, cancelOpenJobsSteps, enqueueJobOnceSteps } from "./jobs";
import {
  ensureRestartQuestionSteps,
  holdRestartSteps,
  restartQuestionStandsSteps,
} from "./restart-hold";
import { getRunSteps, markRunSteps, releaseRunCapacitySteps } from "./runs";
import { pendingRestartHandoffSteps } from "./restart";
import { getTaskModeSteps } from "./tasks";

export async function applyDecision(
  store: Db,
  item: WorkItemRecord,
  decision: StartupDecision,
  now: number,
  options: { runAt?: number } = {},
): Promise<void> {
  const armed = await store.transaction((q) => applyDecisionSteps(q, item, decision, now, options));
  if (armed) emitJobReady(store);
}

export function* applyDecisionSteps(
  q: Q,
  item: WorkItemRecord,
  decision: StartupDecision,
  now: number,
  { runAt = now }: { runAt?: number } = {},
): Steps<boolean> {
  switch (decision.type) {
    case "none":
      return false;
    case "resume":
      return yield* applyResumeSteps(
        q,
        item,
        decision.checkpoint,
        now,
        runAt,
        decision.reattach === true,
      );
    case "reverify":
      return yield* applyReverifySteps(q, item, now, decision.resumed === true);
    case "keep_place":
      return yield* applyKeepPlaceSteps(q, item, decision.mergeCallInFlight, now);
    case "ask_restart":
      return yield* applyAskRestartSteps(q, item, now);
    default: {
      const exhaustive: never = decision;
      throw new Error(`Unhandled decision ${JSON.stringify(exhaustive)}`);
    }
  }
}

function* applyResumeSteps(
  q: Q,
  item: WorkItemRecord,
  checkpoint: Checkpoint | null,
  now: number,
  runAt: number,
  reattach: boolean,
): Steps<boolean> {
  if (!reattach && (item.state === "running" || item.state === "verifying")) {
    yield* applyWorkItemEventSteps(q, item.id, "lease_expired");
  }
  if (!reattach) yield* markResumedSteps(q, item.id, now);
  const current = (yield* getWorkItemSteps(q, item.id)) ?? item;
  if (current.currentRunId !== null) {
    const run = yield* getRunSteps(q, current.currentRunId);
    if (run && run.status === "lost") yield* markRunSteps(q, run.id, "active", now);
  }
  const restartHandoff =
    !reattach &&
    item.acceptedHead === null &&
    checkpoint === null &&
    (yield* getTaskModeSteps(q, item.id)) === "code"
      ? `Paws restarted before this task saved a checkpoint, and the earlier session is gone. Start again${item.branchName ? ` from the branch ${item.branchName}` : ""}: keep any work already on it and finish the issue.`
      : null;
  return (yield* enqueueJobOnceSteps(q, {
    queue: JOB_KIND.resume,
    jobKey: `resume:${item.id}:${current.version}:${now}`,
    payload: {
      itemId: item.id,
      runId: current.currentRunId,
      freshSession: true,
      checkpoint,
      ...(restartHandoff === null ? {} : { handoff: restartHandoff }),
      reason: "process_restart",
      ...(yield* pendingRestartHandoffSteps(q, item.id)),
    },
    runAt,
    now,
  })).inserted;
}

/** Already resumed once: ask in Linear. Any answer starts the task again through the answer resume. */
function* applyAskRestartSteps(q: Q, item: WorkItemRecord, now: number): Steps<boolean> {
  if (item.sessionKey === null) {
    yield* failWorkItemSteps(
      q,
      item,
      "resume_already_attempted",
      "Stopped after a restart because this run was already resumed once.",
      now,
    );
    return false;
  }
  if (item.state === "running" || item.state === "verifying")
    yield* applyWorkItemEventSteps(q, item.id, "lease_expired");
  const held = (yield* getWorkItemSteps(q, item.id)) ?? item;
  yield* holdRestartSteps(q, held, now);
  if (yield* restartQuestionStandsSteps(q, held)) return false;
  yield* cancelOpenJobsSteps(q, { itemId: item.id, reason: "restart_question", now });
  if (held.currentRunId) yield* releaseRunCapacitySteps(q, held.currentRunId, now);
  return (yield* ensureRestartQuestionSteps(q, held, now)).armed;
}

function* applyReverifySteps(
  q: Q,
  item: WorkItemRecord,
  now: number,
  resumed: boolean,
): Steps<boolean> {
  yield* cancelOpenJobsSteps(q, {
    itemId: item.id,
    reason: resumed ? "interrupted_verification" : "sleep_interrupted_merge",
    now,
  });
  if (resumed) yield* markResumedSteps(q, item.id, now);
  if (item.checkpoint?.phase === "merge_queue") {
    yield* saveCheckpointSteps(q, item.id, { ...item.checkpoint, phase: "verifying" });
  }
  if (item.state === "merge_queue") yield* applyWorkItemEventSteps(q, item.id, "lease_expired");
  const refreshed = (yield* getWorkItemSteps(q, item.id)) ?? item;
  return (yield* enqueueJobOnceSteps(q, {
    queue: JOB_KIND.reverify,
    jobKey: `reverify:startup:${item.id}:${now}`,
    payload: {
      itemId: item.id,
      runId: refreshed.currentRunId,
      recheckHead: true,
      failClosed: true,
    },
    now,
  })).inserted;
}

/**
 * The item stays in `merge_queue` with its place, and its merge job picks it up again. A job the
 * shutdown ended is queued again from its last payload. After a merge call that may have reached
 * GitHub, the job runs now and asks GitHub first: merged records the merge, anything else re-verifies.
 */
function* applyKeepPlaceSteps(
  q: Q,
  item: WorkItemRecord,
  mergeCallInFlight: boolean,
  now: number,
): Steps<boolean> {
  const { job } = q.t;
  const matches = and(
    eq(job.queue, JOB_KIND.merge),
    q.dialect === "sqlite"
      ? sql`json_extract(${job.payload}, '$.itemId') = ${item.id}`
      : sql`${job.payload}->>'itemId' = ${item.id}`,
  );
  const open = yield* q.all(
    q.orm
      .select({ id: job.id })
      .from(job)
      .where(and(matches, inArray(job.status, ["pending", "running"]))),
  );
  if (open.length > 0) {
    if (mergeCallInFlight)
      for (const { id } of open)
        yield* q.exec(
          q.orm
            .update(job)
            .set({
              payload:
                q.dialect === "sqlite"
                  ? sql`json_set(${job.payload}, '$.mergeCallInFlight', json('true'))`
                  : sql`jsonb_set(${job.payload}, '{mergeCallInFlight}', 'true'::jsonb)`,
              runAt:
                q.dialect === "sqlite"
                  ? sql`MIN(${job.runAt}, ${now})`
                  : sql`LEAST(${job.runAt}, ${now})`,
            })
            .where(eq(job.id, id)),
        );
    return false;
  }
  const last = yield* q.one(
    q.orm.select({ payload: job.payload }).from(job).where(matches).orderBy(desc(job.id)).limit(1),
  );
  const payload =
    last === undefined
      ? { itemId: item.id }
      : ((typeof last.payload === "string" ? JSON.parse(last.payload) : last.payload) as object);
  return (yield* enqueueJobOnceSteps(q, {
    queue: JOB_KIND.merge,
    jobKey: `merge:startup:${item.id}:${now}`,
    payload: mergeCallInFlight ? { ...payload, mergeCallInFlight: true } : payload,
    now,
  })).inserted;
}
