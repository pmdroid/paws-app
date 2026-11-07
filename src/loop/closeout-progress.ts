import type { Database } from "bun:sqlite";
import type { CloseoutProgress } from "../closeout";
import {
  appendCloseoutOutput,
  ensureCloseoutProgress,
  finishCloseoutProgress,
  getWorkItem,
  saveCheckpoint,
  upsertCloseoutStep,
} from "../db";

export function createDbCloseoutProgress(
  db: Database,
  itemId: string,
  now: () => number = Date.now,
): CloseoutProgress {
  return {
    begin(identity) {
      ensureCloseoutProgress(db, itemId, identity, now(), true);
      const checkpoint = getWorkItem(db, itemId)?.checkpoint;
      if (checkpoint === undefined || checkpoint === null) return;
      if (identity.base.length === 0 || identity.head.length === 0) return;
      if (checkpoint.baseSha === identity.base && checkpoint.wipCommit === identity.head) return;
      saveCheckpoint(db, itemId, {
        ...checkpoint,
        baseSha: identity.base,
        wipCommit: identity.head,
      });
    },
    step(identity, step) {
      upsertCloseoutStep(db, itemId, identity, step, now());
    },
    output(identity, stepId, stream, text, truncated) {
      appendCloseoutOutput(db, itemId, identity, stepId, stream, text, truncated, now());
    },
    finish(identity, decision) {
      finishCloseoutProgress(db, itemId, identity, decision, now());
    },
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
  const queue = (action: () => void | Promise<void>) => {
    chain = chain.then(action).catch((error: unknown) => {
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
          inner.step(identity, { ...step, state: "failed", detail: UNSTORED });
          return;
        }
        inner.step(identity, step);
      }),
    output: (identity, stepId, stream, text, truncated) =>
      queue(() => inner.output(identity, stepId, stream, text, truncated)),
    finish: (identity, decision) =>
      queue(async () => {
        inner.finish(identity, (await stored()) ? decision : "blocked");
      }),
    async settled() {
      await chain;
      if (failure !== null) throw failure.error;
    },
  };
}
