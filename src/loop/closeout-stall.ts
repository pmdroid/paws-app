import type { Database } from "bun:sqlite";
import { JOB_KIND, journalCaught } from "../core";
import {
  cancelOpenJobs,
  enqueueJobOnce,
  getWorkItem,
  immediate,
  itemActivityFacts,
  listAgentCloseout,
  listCloseoutProgress,
  listItemIds,
  listJobs,
  listLastWorkItemEventTimes,
  saveCloseoutRecovery,
  type WorkItemRecord,
} from "../db";
import { RETRY_CLOSEOUT } from "./closeout-recovery";
import { ask } from "./operations";

const QUIET_MS = 30 * 60_000;

/**
 * The retry is keyed on the item and head, not the run: `run.reverify` opens a new run for the
 * same head, and the key must still find its one automatic retry after that and after a restart.
 */
export async function recoverStalledCloseout(
  db: Database,
  input: {
    now: number;
    cancel: (itemId: string) => Promise<void>;
    journal: (line: string) => void;
  },
): Promise<void> {
  const items = listItemIds(db, false)
    .map((id) => getWorkItem(db, id))
    .filter((item) => item?.state === "verifying" && !item.cancelRequested && item.sessionKey);
  if (items.length === 0) return;
  const times = listLastWorkItemEventTimes(db);
  const progress = listCloseoutProgress(db);
  const jobs = listJobs(db);
  for (const item of items as WorkItemRecord[]) {
    const id = item.id;
    const head = item.checkpoint?.wipCommit ?? "";
    const records = progress.filter((p) => p.itemId === id);
    const key = `closeout-stall:${id}:${head}`;
    const retry = jobs.find((job) => job.jobKey === key);
    const since = Math.max(
      times.get(id) ?? 0,
      retry?.createdAt ?? 0,
      ...records.map((p) => p.updatedAt),
      ...listAgentCloseout(db, item.currentRunId ? [item.currentRunId] : []).map((e) => e.at),
    );
    const facts = itemActivityFacts(db, item, input.now);
    if (input.now - since < QUIET_MS || facts.liveRunner || facts.usagePause) continue;
    // A failed cancel must not stop the sweep: the job would go dead and strand the other items.
    try {
      // Fence the old job before joining it, preventing a competing finalizer recovery.
      cancelOpenJobs(db, { itemId: id, reason: "Closeout stalled", now: input.now });
      await input.cancel(id);
      immediate(db, () => {
        const current = getWorkItem(db, id);
        if (current?.state !== "verifying" || current.version !== item.version) return;
        if (!retry) {
          enqueueJobOnce(db, {
            queue: JOB_KIND.reverify,
            jobKey: key,
            payload: { itemId: id },
            now: input.now,
          });
          input.journal(
            `closeout stalled for ${Math.floor((input.now - since) / 60_000)} min, re-running once`,
          );
          return;
        }
        const { question } = ask(
          db,
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
        saveCloseoutRecovery(db, {
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
      });
    } catch (error) {
      journalCaught(error, "closeout-stall.recover", id, undefined, input.journal);
    }
  }
}
