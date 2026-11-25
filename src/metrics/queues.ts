import { jobQueueDepthsSteps, outboxQueueDepthsSteps, type Db, type QueueDepthRow } from "../db";
import { defaultRecorder, type MetricsRecorder } from "./recorder";

export const QUEUE_DEPTH_JOB = "metrics.queues";
export const QUEUE_DEPTH_EVERY_MS = 30_000;

export async function recordQueueDepths(
  db: Db,
  options: { recorder?: MetricsRecorder; now?: number } = {},
): Promise<void> {
  const now = options.now ?? Date.now();
  const recorder = options.recorder ?? defaultRecorder;
  const jobs = await db.run((q) => jobQueueDepthsSteps(q, now));
  const outbox = await db.run((q) => outboxQueueDepthsSteps(q, now));
  const gauges = (prefix: string, label: string, rows: readonly QueueDepthRow[]) => {
    for (const row of rows) {
      recorder.setGauge(`${prefix}.depth`, { [label]: row.key }, row.depth);
      recorder.setGauge(`${prefix}.oldest_age_ms`, { [label]: row.key }, now - row.oldestAt);
    }
  };
  gauges("job", "queue", jobs);
  gauges("outbox", "kind", outbox);
}
