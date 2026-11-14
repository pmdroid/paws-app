import { setImmediate as yieldToLoop } from "node:timers/promises";
import {
  pruneFinishedAgentModelProbesSteps,
  pruneFinishedJobsSteps,
  pruneHandledInboxEventsSteps,
  pruneLinearAccessEventsSteps,
  pruneRunnerEventsSteps,
  pruneEndedRunnerCommandsSteps,
  pruneEndedRunnerHelpersSteps,
  pruneRunnerFollowUpsSteps,
  pruneRunnerHealthResultsSteps,
  pruneRunnerQuestionAnswersSteps,
  pruneSentOutboxSteps,
  pruneSupersededRunnerResultsSteps,
  type Db,
  type Q,
  type Steps,
} from "../db";

export const RUNNER_EVENT_PRUNE_JOB = "runner-events.prune";
export const RUNNER_EVENT_PRUNE_EVERY_MS = 3_600_000;
export const RUNNER_EVENT_RETENTION_MS = 7 * 86_400_000;
export const ACTIVITY_RETENTION_MS = 86_400_000;
const DAY = 86_400_000;
const BATCH = 5_000;

export const LOOP_QUEUE_RETENTION_MS = {
  job: 7 * DAY,
  outbox: 7 * DAY,
  inbox_event: 14 * DAY,
  linear_access_event: 30 * DAY,
  agent_model_probe: 7 * DAY,
} as const;

type LoopQueue = keyof typeof LOOP_QUEUE_RETENTION_MS;
type PruneSteps = (q: Q, cutoff: number, limit: number) => Steps<number>;

const LOOP_QUEUE_PRUNES: Record<LoopQueue, PruneSteps> = {
  job: pruneFinishedJobsSteps,
  outbox: pruneSentOutboxSteps,
  inbox_event: pruneHandledInboxEventsSteps,
  linear_access_event: pruneLinearAccessEventsSteps,
  agent_model_probe: pruneFinishedAgentModelProbesSteps,
};

export const RUNNER_TABLE_RETENTION_MS = {
  runner_question_answer: DAY,
  runner_follow_up: DAY,
  runner_result: 7 * DAY,
  runner_health_result: 0,
  runner_command: 7 * DAY,
  runner_helper: 7 * DAY,
} as const;

type RunnerTable = keyof typeof RUNNER_TABLE_RETENTION_MS;

const RUNNER_TABLE_PRUNES: Record<RunnerTable, PruneSteps> = {
  runner_question_answer: pruneRunnerQuestionAnswersSteps,
  runner_follow_up: pruneRunnerFollowUpsSteps,
  runner_result: pruneSupersededRunnerResultsSteps,
  runner_health_result: pruneRunnerHealthResultsSteps,
  runner_command: pruneEndedRunnerCommandsSteps,
  runner_helper: pruneEndedRunnerHelpersSteps,
};

type PruneOptions = {
  store: Db;
  now?: number;
  signal?: AbortSignal;
  onBatch?: (deleted: number) => void;
};

async function drain(options: PruneOptions, cutoff: number, steps: PruneSteps) {
  let deleted = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    const changes = await options.store.transaction((q) => steps(q, cutoff, BATCH));
    if (!changes) return deleted;
    options.onBatch?.(changes);
    deleted += changes;
    await yieldToLoop();
  }
}

export async function pruneRunnerEvents(options: PruneOptions) {
  const now = options.now ?? Date.now();
  let deleted = 0;
  for (const [retention, type] of [
    [ACTIVITY_RETENTION_MS, "activity"],
    [RUNNER_EVENT_RETENTION_MS, undefined],
  ] as const)
    deleted += await drain(options, now - retention, (q, cutoff, limit) =>
      pruneRunnerEventsSteps(q, cutoff, limit, type),
    );
  return { deleted };
}

export async function pruneLoopQueues(options: PruneOptions) {
  const now = options.now ?? Date.now();
  const deleted = {} as Record<LoopQueue, number>;
  for (const queue of Object.keys(LOOP_QUEUE_PRUNES) as LoopQueue[])
    deleted[queue] = await drain(
      options,
      now - LOOP_QUEUE_RETENTION_MS[queue],
      LOOP_QUEUE_PRUNES[queue],
    );
  return deleted;
}

export async function pruneRunnerTables(options: PruneOptions) {
  const now = options.now ?? Date.now();
  const deleted = {} as Record<RunnerTable, number>;
  for (const table of Object.keys(RUNNER_TABLE_PRUNES) as RunnerTable[])
    deleted[table] = await drain(
      options,
      now - RUNNER_TABLE_RETENTION_MS[table],
      RUNNER_TABLE_PRUNES[table],
    );
  return deleted;
}
