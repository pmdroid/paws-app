import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../core";
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
} from "../db";
import { ask } from "./operations";

const QUIET_MS = 30 * 60_000;

/** Durable retry identity survives a control-plane restart. */
export async function recoverStalledCloseout(
  db: Database,
  input: {
    now: number;
    cancel: (itemId: string) => Promise<void>;
    journal: (line: string) => void;
  },
): Promise<void> {
  const times = listLastWorkItemEventTimes(db);
  const progress = listCloseoutProgress(db);
  for (const id of listItemIds(db, false)) {
    const item = getWorkItem(db, id);
    if (!item || item.state !== "verifying" || item.cancelRequested || !item.sessionKey) continue;
    const head = item.checkpoint?.wipCommit;
    if (!head) continue;
    const records = progress.filter((p) => p.itemId === id && p.head === head);
    const key = `closeout-stall:${id}:${item.currentRunId}:${head}`;
    const retry = listJobs(db).find((job) => job.jobKey === key);
    const since = Math.max(
      times.get(id) ?? 0,
      retry?.createdAt ?? 0,
      ...records.map((p) => p.updatedAt),
      ...listAgentCloseout(db, item.currentRunId ? [item.currentRunId] : [])
        .filter((e) => e.progress.head === head)
        .map((e) => e.at),
    );
    const facts = itemActivityFacts(db, item, input.now);
    if (input.now - since < QUIET_MS || facts.liveRunner || facts.liveJob) continue;
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
      } else {
        const { question } = ask(
          db,
          { itemId: id, runId: item.currentRunId, sessionId: item.sessionKey! },
          "closeout-help",
          "Closeout stalled again after its automatic retry. Retry Closeout on this head, or send back to the agent?",
          {
            options: ["Retry Closeout", "Send back to the agent"],
            now: input.now,
            reason: "closeout_stalled",
          },
        );
        saveCloseoutRecovery(db, {
          questionId: question.id,
          itemId: id,
          taskId: records.at(-1)?.taskId ?? id,
          base: item.checkpoint?.baseSha ?? "",
          head,
          policyDigest: records.at(-1)?.policyDigest ?? "",
          failedChecks: [],
          retryBaseline: [],
          summary: "Closeout stalled twice on the same head.",
        });
      }
    });
  }
}
