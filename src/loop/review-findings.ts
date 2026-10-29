import type { Database } from "bun:sqlite";
import { bugClass, reviewRecordsAt, taskReviewRecords, type Finding } from "../closeout";
import { findingPlace } from "../core";
import {
  acceptedCloseoutReviews,
  acceptedCloseoutRuns,
  getWorkItemRepository,
  recordReviewFindings,
  type AcceptedCloseoutReviews,
  type ReviewFindingReport,
} from "../db";
import { acceptedReviewRecords, nonBlockingFindings, type ReviewRecord } from "./open-findings";

/** The one-time job that fills `review_finding` from the evidence of runs accepted before it. */
export const REVIEW_FINDINGS_BACKFILL_JOB = "review-findings.backfill";

/** Reads every review round stored for a task, at each head. */
export type TaskReviewReader = (
  taskId: string,
) => Promise<Array<ReviewRecord & { head: string; findings: Finding[] }>>;

/**
 * Stores the non-blocking findings of the item's accepted head on the Findings page, read from
 * the same review evidence as the pull request's open findings. `changedPaths` are the files the
 * accepted change touched; with the paths each review reported, they are what the reviews looked
 * at, so an open finding there that is no longer reported is gone. An item without a repository
 * records nothing.
 */
export async function recordAcceptedFindings(
  db: Database,
  input: {
    itemId: string;
    head: string;
    pawsRoot: string;
    now: number;
    changedPaths?: readonly string[];
  },
): Promise<{ recorded: number; gone: number }> {
  const repository = getWorkItemRepository(db, input.itemId);
  const accepted = acceptedCloseoutReviews(db, input.itemId, input.head);
  if (repository === null || accepted === null || accepted.reviews.length === 0)
    return { recorded: 0, gone: 0 };
  const records = await reviewRecordsAt(accepted.taskId, accepted.head, input.pawsRoot);
  return recordRun(db, {
    itemId: input.itemId,
    repository: `${repository.owner}/${repository.repo}`,
    head: accepted.head,
    seenAt: input.now,
    reviews: accepted.reviews,
    records,
    changedPaths: input.changedPaths ?? [],
  });
}

/**
 * Fills the Findings page from every run Closeout accepted, oldest first, reading each task's
 * evidence file once. Running it again changes nothing: a run is recorded at the time Closeout
 * finished it, and an item counts once per finding.
 */
export async function backfillReviewFindings(options: {
  db: Database;
  pawsRoot: string;
  read?: TaskReviewReader;
}): Promise<{ runs: number; recorded: number; gone: number }> {
  const { db } = options;
  const read: TaskReviewReader =
    options.read ?? ((taskId) => taskReviewRecords(taskId, options.pawsRoot));
  const byTask = new Map<string, Awaited<ReturnType<TaskReviewReader>>>();
  let runs = 0;
  let recorded = 0;
  let gone = 0;
  for (const run of acceptedCloseoutRuns(db)) {
    if (run.reviews.length === 0) continue;
    const repository = getWorkItemRepository(db, run.itemId);
    if (repository === null) continue;
    let records = byTask.get(run.taskId);
    if (records === undefined) {
      records = await read(run.taskId);
      byTask.set(run.taskId, records);
    }
    const result = recordRun(db, {
      itemId: run.itemId,
      repository: `${repository.owner}/${repository.repo}`,
      head: run.head,
      seenAt: run.at,
      reviews: run.reviews,
      records: records.filter((entry) => entry.head === run.head),
      changedPaths: [],
    });
    runs++;
    recorded += result.recorded;
    gone += result.gone;
  }
  return { runs, recorded, gone };
}

function recordRun(
  db: Database,
  input: {
    itemId: string;
    repository: string;
    head: string;
    seenAt: number;
    reviews: AcceptedCloseoutReviews["reviews"];
    records: readonly ReviewRecord[];
    changedPaths: readonly string[];
  },
): { recorded: number; gone: number } {
  const findings: ReviewFindingReport[] = nonBlockingFindings(input.reviews, input.records).map(
    (finding) => ({
      review: finding.reviewId,
      severity: finding.severity,
      location: finding.location,
      text: finding.explanation,
      bugClass: bugClass(finding.explanation),
      why: finding.why,
    }),
  );
  const reviewed = acceptedReviewRecords(input.reviews, input.records).map(
    ({ review, record }) => ({
      review: review.id,
      paths: [
        ...input.changedPaths,
        ...record.findings.map((finding) => findingPlace(finding.location).path),
      ],
    }),
  );
  return recordReviewFindings(db, {
    itemId: input.itemId,
    repository: input.repository,
    head: input.head,
    seenAt: input.seenAt,
    findings,
    reviewed,
  });
}
