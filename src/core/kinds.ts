/** Queues this process enqueues. Other modules register handlers for their own queues. */
export const JOB_KIND = {
  command: "core.command",
  resume: "run.resume",
  start: "item.start",
  reverify: "run.reverify",
  merge: "github.merge",
  closeStoppedPull: "github.close_stopped",
  /** One per GitHub review id; the payload names the review, not the item, so a restart keeps it. */
  pullReview: "github.pull_review",
  catchup: "linear.catchup",
  visualReviewReminder: "linear.visual_review_reminder",
  /** Written by the SQLite triggers of migration 144, one pending job per hold owner. */
  runnerSetupCheck: "runner_setup.check",
} as const;

export const MERGE_LANE = "merge";

/** Activity rows the host posts. Delivery to Linear is a later dispatcher. */
export const OUTBOX_ACTIVITY = {
  target: "linear",
  op: "activity",
} as const;

export const MERGE_WORK = {
  queue: JOB_KIND.merge,
  queuePrefix: `${JOB_KIND.merge}.`,
  lane: MERGE_LANE,
  lanePrefix: `${MERGE_LANE}:`,
} as const;

export function isMergeWork(queue: string, lane: string): boolean {
  return (
    queue === MERGE_WORK.queue ||
    queue.startsWith(MERGE_WORK.queuePrefix) ||
    lane === MERGE_WORK.lane ||
    lane.startsWith(MERGE_WORK.lanePrefix)
  );
}
