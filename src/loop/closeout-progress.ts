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
