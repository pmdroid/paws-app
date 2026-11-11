import type { Database } from "bun:sqlite";
import type { Checkpoint, StageLimits } from "../core";
import { settled, sqliteDb, type Q } from "./db";
import {
  applyWorkItemEventSteps,
  configureWorkItemSteps,
  getWorkItemSteps,
  saveCheckpointSteps,
  setCurrentRunSteps,
  type WorkItemRecord,
} from "./items";
import { insertRunSteps, type StoredRun } from "./runs";

type QueuedItemInput = {
  id?: string;
  now?: number;
  title?: string;
  branchName?: string;
  sessionKey?: string;
  maxAwakeMs?: number;
  limits?: Partial<StageLimits>;
};

function* configureQueuedItemSteps(q: Q, id: string, input: QueuedItemInput) {
  yield* configureWorkItemSteps(q, id, {
    sessionKey: input.sessionKey ?? "session",
    maxAwakeMs: input.maxAwakeMs,
    ...(input.limits ? { limits: input.limits } : {}),
  });
  const item = yield* getWorkItemSteps(q, id);
  if (item === null) throw new Error(`failed to insert ${id}`);
  return item;
}

/** Insert a queued work item. New columns keep their defaults so intake inserts stay valid. */
export function insertQueuedItem(db: Database, input: QueuedItemInput = {}): WorkItemRecord {
  const id = input.id ?? "item-1";
  const now = input.now ?? 0;
  const delegationId = `epic-${id}`;
  db.run(
    `INSERT INTO work_item (
       id, delegation_id, linear_issue_id, linear_identifier, title, state, branch_name, position, created_at
     ) VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, ?)`,
    [
      id,
      delegationId,
      `lin-item-${id}`,
      id,
      input.title ?? "Work item",
      input.branchName ?? `paws/${id}`,
      now,
    ],
  );
  return settled(sqliteDb(db).run((q) => configureQueuedItemSteps(q, id, input)));
}

export function* beginImplementRunSteps(
  q: Q,
  itemId: string,
  now: number,
  checkpoint?: Checkpoint,
) {
  yield* applyWorkItemEventSteps(q, itemId, "dispatched");
  const run = yield* insertRunSteps(q, {
    itemId,
    now,
    status: "active",
    kind: "implement",
    agent: "cursor",
  });
  yield* setCurrentRunSteps(q, itemId, run.id);
  if (checkpoint !== undefined) yield* saveCheckpointSteps(q, itemId, checkpoint);
  const item = yield* getWorkItemSteps(q, itemId);
  if (item === null) throw new Error(`missing ${itemId}`);
  return { item, run };
}

export function beginImplementRun(
  db: Database,
  itemId: string,
  now: number,
  checkpoint?: Checkpoint,
): { item: WorkItemRecord; run: StoredRun } {
  return settled(
    sqliteDb(db).transaction((q) => beginImplementRunSteps(q, itemId, now, checkpoint)),
  );
}

export function* enterMergeQueueSteps(q: Q, itemId: string, checkpoint: Checkpoint) {
  yield* applyWorkItemEventSteps(q, itemId, "turn_ended");
  yield* applyWorkItemEventSteps(q, itemId, "closeout_accepted");
  yield* saveCheckpointSteps(q, itemId, { ...checkpoint, phase: "merge_queue" });
}

export function enterMergeQueue(db: Database, itemId: string, checkpoint: Checkpoint): void {
  settled(sqliteDb(db).transaction((q) => enterMergeQueueSteps(q, itemId, checkpoint)));
}
