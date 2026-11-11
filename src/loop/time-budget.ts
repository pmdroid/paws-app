import { DEFAULT_MAX_AWAKE_MS, stageLimits, type StageLimits, type TimeStage } from "../core";
import {
  configureWorkItemSteps,
  enqueueOutboxOnceSteps,
  getWorkItemSteps,
  resetAwakeTimeSteps,
  resetStageTimeSteps,
  type Q,
  type Steps,
} from "../db";

const STAGE_LIMIT_NAME: Record<TimeStage, string> = {
  implementation: "implementation",
  fixes: "fixes",
  closeout: "Closeout",
};

export function freshBudgetLine(limitMs: number, stage?: TimeStage): string {
  if (limitMs <= 0)
    return `Starting on your request; ${STAGE_LIMIT_NAME[stage ?? "implementation"]} time is not limited.`;
  const minutes = Math.max(1, Math.round(limitMs / 60_000));
  const limit = minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`;
  return `Starting on your request with a fresh ${limit}${stage ? ` ${STAGE_LIMIT_NAME[stage]}` : ""} time limit.`;
}

type FreshBudget = {
  itemId: string;
  sessionId: string | null;
  key: string;
  maxAwakeMs?: number;
  limits?: StageLimits | undefined;
  stage?: TimeStage | undefined;
  now: number;
};

export function* startFreshBudgetSteps(q: Q, input: FreshBudget): Steps<void> {
  const limits: Partial<StageLimits> = input.limits ?? {
    implementation: input.maxAwakeMs ?? DEFAULT_MAX_AWAKE_MS,
  };
  if (input.stage === undefined) yield* resetAwakeTimeSteps(q, input.itemId);
  else yield* resetStageTimeSteps(q, input.itemId, input.stage);
  yield* configureWorkItemSteps(q, input.itemId, { limits });
  if (input.sessionId === null) return;
  const item = yield* getWorkItemSteps(q, input.itemId);
  const shown = input.stage ?? "implementation";
  const limitMs = item === null ? (limits[shown] ?? 0) : stageLimits(item)[shown];
  yield* enqueueOutboxOnceSteps(q, {
    target: "linear",
    op: "activity",
    orderingKey: input.sessionId,
    idempotencyKey: `fresh-budget:${input.key}`,
    payload: {
      sessionId: input.sessionId,
      kind: "thought",
      body: freshBudgetLine(limitMs, input.stage),
    },
    now: input.now,
  });
}
