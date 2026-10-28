/** Queues this process enqueues. Other modules register handlers for their own queues. */
export const JOB_KIND = {
  command: "core.command",
  resume: "run.resume",
  start: "item.start",
  reverify: "run.reverify",
  merge: "github.merge",
  /** Main moved: queued pull requests behind the front that now conflict go back for a rebase. */
  queueConflicts: "github.queue_conflicts",
  closeStoppedPull: "github.close_stopped",
  /** One per GitHub review id; the payload names the review, not the item, so a restart keeps it. */
  pullReview: "github.pull_review",
  /**
   * Comments on an item's pull request, gathered into one restart. The payload names the item as
   * `pullCommentsFor`, not `itemId`, so a restart does not cancel it.
   */
  pullComments: "github.pull_comments",
  catchup: "linear.catchup",
  visualReviewReminder: "linear.visual_review_reminder",
  /** The one reminder of an open link ask, 24 hours after it was asked. */
  linkAskReminder: "linear.link_ask_reminder",
  /** Written when a redelivered elicitation dies too; the loop re-asks through ask(). */
  reaskQuestion: "question.reask",
  /** Written by the SQLite triggers of migration 144, one pending job per hold owner. */
  runnerSetupCheck: "runner_setup.check",
} as const;

/** Activity rows the host posts. Delivery to Linear is a later dispatcher. */
export const OUTBOX_ACTIVITY = {
  target: "linear",
  op: "activity",
} as const;

export const MERGE_WORK = {
  queue: JOB_KIND.merge,
  queuePrefix: `${JOB_KIND.merge}.`,
} as const;

export function isMergeWork(queue: string): boolean {
  return queue === MERGE_WORK.queue || queue.startsWith(MERGE_WORK.queuePrefix);
}
