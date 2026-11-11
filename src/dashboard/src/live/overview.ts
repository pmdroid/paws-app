import {
  listCloseoutProgressStatesSteps,
  listItemHoldsSteps,
  listJobsSteps,
  listLastWorkItemEventTimesSteps,
  listMergeQueuesSteps,
  listOpenQuestionsSteps,
  listQueuePositions,
  type Db,
  listRunsSteps,
  listVisualReviewsSteps,
  listWorkItemFactsSteps,
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

export async function readOverview(
  store: Db,
  options: LiveStatusOptions,
): Promise<OverviewResponse> {
  const now = options.now?.() ?? new Date();
  const nowMs = now.getTime();
  const generatedAt = now.toISOString();
  const facts = new Map(
    (await store.run(listWorkItemFactsSteps)).map((fact) => [fact.itemId, fact]),
  );
  const visible = await visibleRecords(store, options, facts);
  const listed = await listedRecords(store, visible, facts, nowMs);
  const rows = await readerOutbox(store, options);
  const openQuestions = await store.run(listOpenQuestionsSteps);
  const questions: OverviewQuestion[] = (
    await questionsFor(store, listed, rows, () => null, openQuestions)
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
  const changed = await store.run(listLastWorkItemEventTimesSteps);
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
  const places = mergePlaces(await store.run((q) => listMergeQueuesSteps(q)), visible);
  const firstQuestion = new Map<string, string>();
  for (const question of openQuestions)
    if (!firstQuestion.has(question.itemId))
      firstQuestion.set(question.itemId, questionLine(question.body));
  const storedRuns = new Map<string, StoredRun[]>();
  for (const run of await store.run((q) => listRunsSteps(q)))
    storedRuns.set(run.itemId, [...(storedRuns.get(run.itemId) ?? []), run]);
  const context: IssueContext = {
    store,
    options,
    nowMs,
    generatedAt,
    facts,
    rows,
    changed,
    jobs: await store.run(listJobsSteps),
    progress: await store.run(listCloseoutProgressStatesSteps),
    itemsByIssue: latestByLinearIssue(visible, facts),
    queue: new Map((await listQueuePositions(store)).map((entry) => [entry.itemId, entry])),
    places,
    holds: new Map(
      (await store.run((q) => listItemHoldsSteps(q))).map((hold) => [hold.itemId, hold]),
    ),
    firstQuestion,
    storedRuns,
  };
  const intake = await readIntake(store, options);
  const issues: OverviewIssue[] = [];
  for (const record of shown) issues.push(await overviewIssue(record, context));
  return {
    source: "live",
    generatedAt,
    issues,
    questions,
    mergedTimes: (await mergedTimesFor(store, visible, facts, nowMs)).mergedTimes ?? null,
    intake: intake.intake ?? [],
    linearBudget: intake.linearBudget ?? null,
    linearWebhook: intake.linearWebhook ?? null,
    pushOutages: (await readPushOutages(store, options)).pushOutages ?? [],
    policyRunnerWarnings:
      (await readPolicyRunnerWarnings(store, options)).policyRunnerWarnings ?? [],
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
  store: Db;
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

async function overviewIssue(
  record: WorkItemRecord,
  context: IssueContext,
): Promise<OverviewIssue> {
  const { store, nowMs } = context;
  const id = publicId(record);
  const current = context.storedRuns.get(record.id)?.find((run) => run.id === record.currentRunId);
  const pause = current ? await runUsagePause(store, current.id, context.generatedAt) : null;
  const reviews = await store.run((q) => listVisualReviewsSteps(q, record.id));
  const last = reviews.at(-1);
  const place =
    record.state === "merge_queue" || record.state === "verifying"
      ? context.places.get(record.id)
      : undefined;
  const blockers = await blockersFor(store, record, context.itemsByIssue);
  const held = await heldOf(record, context.holds);
  const history = await historyOf(store, record, context.facts, nowMs);
  const doing = await doingFor(store, record, {
    hold: context.holds.get(record.id),
    question: context.firstQuestion.get(record.id) ?? null,
    lastChange: context.changed.get(record.id) ?? context.facts.get(record.id)?.createdAt ?? nowMs,
    now: nowMs,
  });
  return {
    id,
    title: textOr(record.title, id),
    state: itemState(record.state),
    project: itemProject(context.facts.get(record.id)),
    blockers,
    pr: pullRequest(record, context.rows, context.options.project?.repo),
    ...queueOf(record, context.queue),
    ...(place ? { mergeQueue: place } : {}),
    ...held,
    ...history,
    ...doing,
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
