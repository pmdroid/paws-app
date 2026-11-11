import type { LinearCommand } from "../core";
import { listWorkItemsSteps, type Db } from "../db";
import { journalCaught } from "../journal";
import type { LinearIssueClosed, TrackerRequestOptions } from "../linear";
import { closeClosedIssueTasks, type ClosedIssueTask } from "./linear-administration";

export const FAILED_ISSUE_SWEEP_JOB = "linear.failed-issues.sweep";
export const FAILED_ISSUE_SWEEP_MS = 6 * 60 * 60 * 1000;

export async function sweepFailedIssues(
  store: Db,
  options: {
    readIssueClosures(
      ids: readonly string[],
      options?: TrackerRequestOptions,
    ): Promise<LinearIssueClosed[]>;
    notify: (command: LinearCommand) => void;
    interrupt?: (sessionId: string) => Promise<void>;
    signal?: AbortSignal;
    now?: () => number;
  },
): Promise<ClosedIssueTask[]> {
  const ids = [
    ...new Set(
      (await store.run(listWorkItemsSteps))
        .filter((item) => item.state === "failed" && item.linearIssueId !== "")
        .map((item) => item.linearIssueId),
    ),
  ];
  if (ids.length === 0) return [];
  let closures: LinearIssueClosed[];
  try {
    closures = await options.readIssueClosures(
      ids,
      options.signal ? { signal: options.signal } : undefined,
    );
  } catch (error) {
    journalCaught(error, "failed-issue-sweep.read", null, "the failed-item sweep skipped a round");
    return [];
  }
  const closed: ClosedIssueTask[] = [];
  for (const closure of closures)
    if (ids.includes(closure.issueId))
      closed.push(...(await closeClosedIssueTasks(store, closure, options)));
  return closed;
}
