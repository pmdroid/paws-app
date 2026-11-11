import { JOB_KIND, journalCaught } from "../core";
import {
  cancelOpenJobsSteps,
  emitJobReady,
  enqueueJobOnceSteps,
  getWorkItemSteps,
  itemActivityFactsSteps,
  listAgentCloseoutSteps,
  listCloseoutProgressSteps,
  listItemIdsSteps,
  listJobsSteps,
  listLastWorkItemEventTimesSteps,
  saveCloseoutRecoverySteps,
  type WorkItemRecord,
  type Db,
} from "../db";
import { RETRY_CLOSEOUT } from "./closeout-recovery";
import { askSteps } from "./operations";

const QUIET_MS = 30 * 60_000;

/**
 * The retry is keyed on the item and head, not the run: `run.reverify` opens a new run for the
 * same head, and the key must still find its one automatic retry after that and after a restart.
 */
export async function recoverStalledCloseout(
  store: Db,
  input: {
    now: number;
    cancel: (itemId: string) => Promise<void>;
    journal: (line: string) => void;
  },
): Promise<void> {
  const items = await store.run(function* (q) {
    const stalled: WorkItemRecord[] = [];
    for (const id of yield* listItemIdsSteps(q, false)) {
      const item = yield* getWorkItemSteps(q, id);
      if (item?.state === "verifying" && !item.cancelRequested && item.sessionKey)
        stalled.push(item);
    }
    return stalled;
  });
  if (items.length === 0) return;
  const times = await store.run(listLastWorkItemEventTimesSteps);
  const progress = await store.run(listCloseoutProgressSteps);
  const jobs = await store.run(listJobsSteps);
  for (const item of items) {
    const id = item.id;
    const head = item.checkpoint?.wipCommit ?? "";
    const records = progress.filter((p) => p.itemId === id);
    const key = `closeout-stall:${id}:${head}`;
    const retry = jobs.find((job) => job.jobKey === key);
    const agentCloseout = await store.run((q) =>
      listAgentCloseoutSteps(q, item.currentRunId ? [item.currentRunId] : []),
    );
    const since = Math.max(
      times.get(id) ?? 0,
      retry?.createdAt ?? 0,
      ...records.map((p) => p.updatedAt),
      ...agentCloseout.map((e) => e.at),
    );
    const facts = await store.run((q) => itemActivityFactsSteps(q, item, input.now));
    if (input.now - since < QUIET_MS || facts.liveRunner || facts.usagePause) continue;
    // A failed cancel must not stop the sweep: the job would go dead and strand the other items.
    try {
      // Fence the old job before joining it, preventing a competing finalizer recovery.
      await store.run((q) =>
        cancelOpenJobsSteps(q, { itemId: id, reason: "Closeout stalled", now: input.now }),
      );
      await input.cancel(id);
      const enqueued = await store.transaction(function* (q) {
        const current = yield* getWorkItemSteps(q, id);
        if (current?.state !== "verifying" || current.version !== item.version) return false;
        if (!retry) {
          const { inserted } = yield* enqueueJobOnceSteps(q, {
            queue: JOB_KIND.reverify,
            jobKey: key,
            payload: { itemId: id },
            now: input.now,
          });
          input.journal(
            `closeout stalled for ${Math.floor((input.now - since) / 60_000)} min, re-running once`,
          );
          return inserted;
        }
        const { question } = yield* askSteps(
          q,
          { itemId: id, runId: item.currentRunId, sessionId: item.sessionKey! },
          "closeout-help",
          "Closeout stalled again after its automatic retry. Retry Closeout on this head, or send back to the agent?",
          {
            options: [RETRY_CLOSEOUT, "Send back to the agent"],
            now: input.now,
            reason: "closeout_stalled",
          },
        );
        const last = records.filter((p) => p.head === head).at(-1);
        yield* saveCloseoutRecoverySteps(q, {
          questionId: question.id,
          itemId: id,
          taskId: last?.taskId ?? id,
          base: item.checkpoint?.baseSha ?? "",
          head,
          policyDigest: last?.policyDigest ?? "",
          failedChecks: [],
          retryBaseline: [],
          summary: "Closeout stalled twice on the same head.",
        });
        return false;
      });
      if (enqueued) emitJobReady(store);
    } catch (error) {
      journalCaught(error, "closeout-stall.recover", id, undefined, input.journal);
    }
  }
}
