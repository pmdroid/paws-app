import type { Database } from "bun:sqlite";
import type { Checkpoint, StageLimits } from "../core";
import { sqliteDb, type Db, type Q } from "./db";
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
export async function insertQueuedItem(
  db: Database | Db,
  input: QueuedItemInput = {},
): Promise<WorkItemRecord> {
  const id = input.id ?? "item-1";
  const row = {
    id,
    delegationId: `epic-${id}`,
    linearIssueId: `lin-item-${id}`,
    linearIdentifier: id,
    title: input.title ?? "Work item",
    branchName: input.branchName ?? `paws/${id}`,
    createdAt: input.now ?? 0,
  };
  if ("dialect" in db)
    return await db.transaction(function* (q) {
      yield* q.exec(q.orm.insert(q.t.workItem).values({ ...row, state: "queued", position: 0 }));
      return yield* configureQueuedItemSteps(q, id, input);
    });
  db.run(
    `INSERT INTO work_item (
       id, delegation_id, linear_issue_id, linear_identifier, title, state, branch_name, position, created_at
     ) VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, ?)`,
    [
      row.id,
      row.delegationId,
      row.linearIssueId,
      row.linearIdentifier,
      row.title,
      row.branchName,
      row.createdAt,
    ],
  );
  return await sqliteDb(db).run((q) => configureQueuedItemSteps(q, id, input));
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

export async function beginImplementRun(
  store: Db,
  itemId: string,
  now: number,
  checkpoint?: Checkpoint,
): Promise<{ item: WorkItemRecord; run: StoredRun }> {
  return store.transaction((q) => beginImplementRunSteps(q, itemId, now, checkpoint));
}

export function* enterMergeQueueSteps(q: Q, itemId: string, checkpoint: Checkpoint) {
  yield* applyWorkItemEventSteps(q, itemId, "turn_ended");
  yield* applyWorkItemEventSteps(q, itemId, "closeout_accepted");
  yield* saveCheckpointSteps(q, itemId, { ...checkpoint, phase: "merge_queue" });
}

export async function enterMergeQueue(
  store: Db,
  itemId: string,
  checkpoint: Checkpoint,
): Promise<void> {
  await store.transaction((q) => enterMergeQueueSteps(q, itemId, checkpoint));
}
