import type { CloseoutProgress } from "../closeout";
import {
  appendCloseoutOutputSteps,
  ensureCloseoutProgressSteps,
  finishCloseoutProgressSteps,
  getWorkItemSteps,
  saveCheckpointSteps,
  upsertCloseoutStepSteps,
  type Db,
} from "../db";

type StoredCloseoutProgress = {
  [K in keyof CloseoutProgress]: (...args: Parameters<CloseoutProgress[K]>) => unknown;
};

export function createDbCloseoutProgress(store: Db, itemId: string, now: () => number = Date.now) {
  return {
    begin: (identity) =>
      store.transaction(function* (q) {
        yield* ensureCloseoutProgressSteps(q, itemId, identity, now(), true);
        const checkpoint = (yield* getWorkItemSteps(q, itemId))?.checkpoint;
        if (checkpoint === undefined || checkpoint === null) return;
        if (identity.base.length === 0 || identity.head.length === 0) return;
        if (checkpoint.baseSha === identity.base && checkpoint.wipCommit === identity.head) return;
        yield* saveCheckpointSteps(q, itemId, {
          ...checkpoint,
          baseSha: identity.base,
          wipCommit: identity.head,
        });
      }),
    step: (identity, step) =>
      store.transaction((q) => upsertCloseoutStepSteps(q, itemId, identity, step, now())),
    output: (identity, stepId, stream, text, truncated) =>
      store.transaction((q) =>
        appendCloseoutOutputSteps(q, itemId, identity, stepId, stream, text, truncated, now()),
      ),
    finish: (identity, decision) =>
      store.transaction((q) => finishCloseoutProgressSteps(q, itemId, identity, decision, now())),
  } satisfies StoredCloseoutProgress;
}

const PUBLISH_ATTEMPTS = 3;
const UNSTORED = "Paws could not store this check's evidence in the object store.";

export function publishingCloseoutProgress(
  inner: StoredCloseoutProgress,
  publish: () => Promise<void>,
): CloseoutProgress & { settled(): Promise<void> } {
  let chain: Promise<void> = Promise.resolve();
  let failure: { error: unknown } | null = null;
  const queue = (action: () => unknown) => {
    chain = chain
      .then(async () => {
        await action();
      })
      .catch((error: unknown) => {
        failure ??= { error };
      });
  };
  const stored = async (): Promise<boolean> => {
    let last: unknown;
    for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt++) {
      try {
        await publish();
        return true;
      } catch (error) {
        last = error;
      }
    }
    failure ??= { error: last };
    return false;
  };
  return {
    begin: (identity) => queue(() => inner.begin(identity)),
    step: (identity, step) =>
      queue(async () => {
        if (
          step.state !== "pending" &&
          step.state !== "running" &&
          (step.logPath !== null || step.evidencePath !== null) &&
          !(await stored())
        ) {
          await inner.step(identity, { ...step, state: "failed", detail: UNSTORED });
          return;
        }
        await inner.step(identity, step);
      }),
    output: (identity, stepId, stream, text, truncated) =>
      queue(() => inner.output(identity, stepId, stream, text, truncated)),
    finish: (identity, decision) =>
      queue(async () => {
        await inner.finish(identity, (await stored()) ? decision : "blocked");
      }),
    async settled() {
      await chain;
      if (failure !== null) throw failure.error;
    },
  };
}
