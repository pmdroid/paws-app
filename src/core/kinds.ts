/** Queues this process enqueues. Other modules register handlers for their own queues. */
export const JOB_KIND = {
  command: "core.command",
  resume: "run.resume",
  start: "item.start",
  reverify: "run.reverify",
  merge: "github.merge",
  closeStoppedPull: "github.close_stopped",
  catchup: "linear.catchup",
} as const;

export const MERGE_LANE = "merge";

/** Activity rows the host posts. Delivery to Linear is a later dispatcher. */
export const OUTBOX_ACTIVITY = {
  target: "linear",
  op: "activity",
} as const;

export function isMergeWork(queue: string, lane: string): boolean {
  return queue === JOB_KIND.merge || lane === MERGE_LANE || queue.startsWith(`${JOB_KIND.merge}.`);
}
