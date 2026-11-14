import type { CloseoutProgress } from "../closeout";
import { moveCloseoutOutput, removeEvidenceFile, type EvidenceStorage } from "../evidence";
import { journalCaught } from "../journal";
import {
  appendCloseoutOutputSteps,
  closeoutProgressId,
  finishedStepOutputSteps,
  ensureCloseoutProgressSteps,
  finishCloseoutProgressSteps,
  getWorkItemSteps,
  saveCheckpointSteps,
  upsertCloseoutStepSteps,
  type Db,
} from "../db";

export function createDbCloseoutProgress(
  store: Db,
  itemId: string,
  now: () => number = Date.now,
  logs?: EvidenceStorage,
): CloseoutProgress {
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
    step: async (identity, step) => {
      const dropped = await store.transaction((q) =>
        upsertCloseoutStepSteps(q, itemId, identity, step, now()),
      );
      if (!logs) return;
      try {
        if (dropped !== null) await removeEvidenceFile(store, logs, dropped);
        if (step.state === "pending" || step.state === "running") return;
        const id = closeoutProgressId(itemId, identity);
        const row = await store.run((q) => finishedStepOutputSteps(q, id, step.id));
        if (row !== null) await moveCloseoutOutput(store, logs, row, now());
      } catch (error) {
        journalCaught(error, "closeout-progress.step.logs", itemId);
      }
    },
    output: (identity, stepId, stream, text, truncated) =>
      store.transaction((q) =>
        appendCloseoutOutputSteps(q, itemId, identity, stepId, stream, text, truncated, now()),
      ),
    finish: (identity, decision) =>
      store.transaction((q) => finishCloseoutProgressSteps(q, itemId, identity, decision, now())),
  };
}

const PUBLISH_ATTEMPTS = 3;
const UNSTORED = "Paws could not store this check's evidence in the object store.";

export function publishingCloseoutProgress(
  inner: CloseoutProgress,
  publish: () => Promise<void>,
): CloseoutProgress & { settled(): Promise<void> } {
  let chain: Promise<void> = Promise.resolve();
  let failure: { error: unknown } | null = null;
  const queue = (action: () => unknown): Promise<void> => {
    chain = chain
      .then(async () => {
        await action();
      })
      .catch((error: unknown) => {
        failure ??= { error };
      });
    return chain;
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
