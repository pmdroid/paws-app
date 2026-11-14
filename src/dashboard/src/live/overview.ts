import {
  getTaskModesSteps,
  itemActivityFactsForItemsSteps,
  listCiRerunsForItemsSteps,
  listCloseoutProgressStatesSteps,
  listConfirmedMergeShasSteps,
  listItemHoldsSteps,
  listJobsSteps,
  listLastWorkItemEventTimesSteps,
  listMergeQueuesSteps,
  listOpenQuestionsSteps,
  listQueuePositions,
  type Db,
  listRunsSteps,
  listTaskBlockersForIssuesSteps,
  listVisualReviewsForItemsSteps,
  listWorkItemEventRowsForItemsSteps,
  listWorkItemFactsSteps,
  runnerWorkActiveForRunsSteps,
  setupFactsSteps,
  usagePausesSteps,
  type CloseoutProgressState,
  type ItemHold,
  type Job,
  type OutboxRow,
  type Q,
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
  blockersFrom,
  closeoutState,
  doingFrom,
  heldOf,
  HISTORY_LIMIT,
  historyFrom,
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
  textOr,
  usagePauseOf,
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
  const itemsByIssue = latestByLinearIssue(visible, facts);
  const reads = await store.run((q) =>
    overviewReadsSteps(q, shown, itemsByIssue, storedRuns, nowMs),
  );
  const context: IssueContext = {
    reads,
    options,
    nowMs,
    generatedAt,
    facts,
    rows,
    changed,
    jobs: await store.run(listJobsSteps),
    progress: await store.run(listCloseoutProgressStatesSteps),
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
  for (const record of shown) issues.push(overviewIssue(record, context));
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
    setup: await store.run(setupFactsSteps),
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
    setup: { github: false, runner: false, agent: false, delegated: false },
  };
}

type OverviewReads =
  ReturnType<typeof overviewReadsSteps> extends Generator<unknown, infer T> ? T : never;

function* overviewReadsSteps(
  q: Q,
  records: readonly WorkItemRecord[],
  itemsByIssue: ReadonlyMap<string, WorkItemRecord>,
  storedRuns: ReadonlyMap<string, readonly StoredRun[]>,
  now: number,
) {
  const ids = records.map((record) => record.id);
  const currents = records.flatMap(
    (record) => storedRuns.get(record.id)?.find((run) => run.id === record.currentRunId)?.id ?? [],
  );
  const edges = yield* listTaskBlockersForIssuesSteps(
    q,
    records.map((record) => record.linearIssueId),
  );
  const blockers = [...edges.values()].flat().flatMap((issue) => itemsByIssue.get(issue)?.id ?? []);
  return {
    pauses: yield* usagePausesSteps(q, currents),
    reviews: yield* listVisualReviewsForItemsSteps(q, ids),
    edges,
    items: itemsByIssue,
    modes: yield* getTaskModesSteps(q, blockers),
    merges: yield* listConfirmedMergeShasSteps(q, blockers),
    events: yield* listWorkItemEventRowsForItemsSteps(q, ids, HISTORY_LIMIT),
    reruns: yield* listCiRerunsForItemsSteps(q, ids),
    activity: yield* itemActivityFactsForItemsSteps(q, records, now),
    active: yield* runnerWorkActiveForRunsSteps(
      q,
      records.flatMap((record) => (record.state === "running" ? (record.currentRunId ?? []) : [])),
    ),
  };
}

type IssueContext = {
  reads: OverviewReads;
  options: LiveStatusOptions;
  nowMs: number;
  generatedAt: string;
  facts: ReadonlyMap<string, WorkItemFact>;
  rows: readonly OutboxRow[];
  changed: ReadonlyMap<string, number>;
  jobs: readonly Job[];
  progress: readonly CloseoutProgressState[];
  queue: ReadonlyMap<string, QueuePosition>;
  places: ReadonlyMap<string, StatusMergeQueue>;
  holds: ReadonlyMap<string, ItemHold>;
  firstQuestion: ReadonlyMap<string, string>;
  storedRuns: ReadonlyMap<string, readonly StoredRun[]>;
};

function overviewIssue(record: WorkItemRecord, context: IssueContext): OverviewIssue {
  const { reads, nowMs } = context;
  const id = publicId(record);
  const current = context.storedRuns.get(record.id)?.find((run) => run.id === record.currentRunId);
  const paused = current ? reads.pauses.get(current.id) : undefined;
  const pause = paused ? usagePauseOf(paused, context.generatedAt) : null;
  const reviews = reads.reviews.get(record.id) ?? [];
  const last = reviews.at(-1);
  const place =
    record.state === "merge_queue" || record.state === "verifying"
      ? context.places.get(record.id)
      : undefined;
  const blockers = blockersFrom(reads, record);
  const held = heldOf(record, context.holds);
  const history = historyFrom(
    record,
    context.facts,
    nowMs,
    reads.events.get(record.id) ?? [],
    reads.reruns.get(record.id) ?? [],
  );
  const active = record.currentRunId === null ? undefined : reads.active.get(record.currentRunId);
  const doing = doingFrom(
    record,
    {
      hold: context.holds.get(record.id),
      question: context.firstQuestion.get(record.id) ?? null,
      lastChange:
        context.changed.get(record.id) ?? context.facts.get(record.id)?.createdAt ?? nowMs,
      now: nowMs,
    },
    reads.activity.get(record.id)!,
    record.state === "running" && active !== undefined ? (active ? "agent" : "preparing") : null,
  );
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
