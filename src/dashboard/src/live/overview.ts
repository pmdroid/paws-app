import type { Database } from "bun:sqlite";
import {
  listCloseoutProgressStates,
  listItemHolds,
  listJobs,
  listLastWorkItemEventTimes,
  listMergeQueues,
  listOpenQuestions,
  listQueuePositions,
  settled,
  sqliteDb,
  listRuns,
  listVisualReviews,
  listWorkItemFacts,
  type CloseoutProgressState,
  type ItemHold,
  type Job,
  type OutboxRow,
  type QueuePosition,
  type StoredRun,
  type WorkItemFact,
  type WorkItemRecord,
} from "../../../db";
import type {
  OverviewIssue,
  OverviewQuestion,
  OverviewResponse,
  StatusMergeQueue,
} from "../contract";
import {
  blockersFor,
  closeoutState,
  doingFor,
  heldOf,
  historyOf,
  itemProject,
  itemState,
  latestByLinearIssue,
  listedRecords,
  mergePlaces,
  mergedTimesFor,
  publicId,
  pullRequest,
  questionLine,
  questionsFor,
  queueOf,
  readerOutbox,
  readIntake,
  readPolicyRunnerWarnings,
  readPushOutages,
  runState,
  runUsagePause,
  textOr,
  visibleRecords,
  visualReviewRounds,
  type LiveStatusOptions,
} from "./provider";

const FINISHED_ITEM_STATES: ReadonlySet<string> = new Set(["merged", "completed", "stopped"]);
export const OVERVIEW_RECENTLY_MERGED = 5;

export function readOverview(db: Database, options: LiveStatusOptions): OverviewResponse {
  const now = options.now?.() ?? new Date();
  const nowMs = now.getTime();
  const generatedAt = now.toISOString();
  const facts = new Map(listWorkItemFacts(db).map((fact) => [fact.itemId, fact]));
  const visible = visibleRecords(db, options, facts);
  const listed = listedRecords(db, visible, facts, nowMs);
  const rows = readerOutbox(db, options);
  const openQuestions = listOpenQuestions(db);
  const questions: OverviewQuestion[] = questionsFor(
    db,
    listed,
    rows,
    () => null,
    openQuestions,
  ).map((question) => ({
    id: question.id,
    itemId: question.itemId,
    title: question.title,
    linkAsk: question.linkAsk
      ? {
          kind: question.linkAsk.kind,
          title: question.linkAsk.title,
          detail: question.linkAsk.detail,
        }
      : null,
  }));
  const asked = new Set(questions.map((question) => question.itemId));
  const changed = listLastWorkItemEventTimes(db);
  const merged = new Set(
    listed
      .filter((record) => record.state === "merged")
      .sort((left, right) => (changed.get(right.id) ?? 0) - (changed.get(left.id) ?? 0))
      .slice(0, OVERVIEW_RECENTLY_MERGED),
  );
  const shown = listed.filter(
    (record) =>
      !FINISHED_ITEM_STATES.has(itemState(record.state)) ||
      asked.has(publicId(record)) ||
      merged.has(record),
  );
  const places = mergePlaces(listMergeQueues(db), visible);
  const firstQuestion = new Map<string, string>();
  for (const question of openQuestions)
    if (!firstQuestion.has(question.itemId))
      firstQuestion.set(question.itemId, questionLine(question.body));
  const storedRuns = new Map<string, StoredRun[]>();
  for (const run of listRuns(db))
    storedRuns.set(run.itemId, [...(storedRuns.get(run.itemId) ?? []), run]);
  const context: IssueContext = {
    db,
    options,
    nowMs,
    generatedAt,
    facts,
    rows,
    changed,
    jobs: listJobs(db),
    progress: listCloseoutProgressStates(db),
    itemsByIssue: latestByLinearIssue(visible, facts),
    queue: new Map(settled(listQueuePositions(sqliteDb(db))).map((entry) => [entry.itemId, entry])),
    places,
    holds: new Map(listItemHolds(db).map((hold) => [hold.itemId, hold])),
    firstQuestion,
    storedRuns,
  };
  const intake = readIntake(db, options);
  return {
    source: "live",
    generatedAt,
    issues: shown.map((record) => overviewIssue(record, context)),
    questions,
    mergedTimes: mergedTimesFor(db, visible, facts, nowMs).mergedTimes ?? null,
    intake: intake.intake ?? [],
    linearBudget: intake.linearBudget ?? null,
    linearWebhook: intake.linearWebhook ?? null,
    pushOutages: readPushOutages(db, options).pushOutages ?? [],
    policyRunnerWarnings: readPolicyRunnerWarnings(db, options).policyRunnerWarnings ?? [],
    mergeQueueCount: listed.filter(
      (record) =>
        record.state === "merge_queue" || (record.state === "verifying" && places.has(record.id)),
    ).length,
  };
}

export function emptyOverview(now = new Date()): OverviewResponse {
  return {
    source: "live",
    generatedAt: now.toISOString(),
    issues: [],
    questions: [],
    mergedTimes: null,
    intake: [],
    linearBudget: null,
    linearWebhook: null,
    pushOutages: [],
    policyRunnerWarnings: [],
    mergeQueueCount: 0,
  };
}

type IssueContext = {
  db: Database;
  options: LiveStatusOptions;
  nowMs: number;
  generatedAt: string;
  facts: ReadonlyMap<string, WorkItemFact>;
  rows: readonly OutboxRow[];
  changed: ReadonlyMap<string, number>;
  jobs: readonly Job[];
  progress: readonly CloseoutProgressState[];
  itemsByIssue: ReadonlyMap<string, WorkItemRecord>;
  queue: ReadonlyMap<string, QueuePosition>;
  places: ReadonlyMap<string, StatusMergeQueue>;
  holds: ReadonlyMap<string, ItemHold>;
  firstQuestion: ReadonlyMap<string, string>;
  storedRuns: ReadonlyMap<string, readonly StoredRun[]>;
};

function overviewIssue(record: WorkItemRecord, context: IssueContext): OverviewIssue {
  const { db, nowMs } = context;
  const id = publicId(record);
  const current = context.storedRuns.get(record.id)?.find((run) => run.id === record.currentRunId);
  const pause = current ? runUsagePause(db, current.id, context.generatedAt) : null;
  const reviews = listVisualReviews(db, record.id);
  const last = reviews.at(-1);
  const place =
    record.state === "merge_queue" || record.state === "verifying"
      ? context.places.get(record.id)
      : undefined;
  return {
    id,
    title: textOr(record.title, id),
    state: itemState(record.state),
    project: itemProject(context.facts.get(record.id)),
    blockers: blockersFor(db, record, context.itemsByIssue),
    pr: pullRequest(record, context.rows, context.options.project?.repo),
    ...queueOf(record, context.queue),
    ...(place ? { mergeQueue: place } : {}),
    ...heldOf(record, context.holds),
    ...historyOf(db, record, context.facts, nowMs),
    ...doingFor(db, record, {
      hold: context.holds.get(record.id),
      question: context.firstQuestion.get(record.id) ?? null,
      lastChange:
        context.changed.get(record.id) ?? context.facts.get(record.id)?.createdAt ?? nowMs,
      now: nowMs,
    }),
    ...(last
      ? {
          visualReviews: [
            { round: visualReviewRounds(reviews).at(-1)!, state: last.outcome ?? "waiting" },
          ],
        }
      : {}),
    run: current
      ? { state: runState(record, current.status), ...(pause ? { usagePause: pause } : {}) }
      : null,
    verdict: closeoutState(record, context.rows, context.jobs, context.progress),
  };
}
