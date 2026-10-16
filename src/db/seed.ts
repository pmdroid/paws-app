import type { Database } from "bun:sqlite";
import type { Checkpoint } from "../core";
import {
  applyWorkItemEvent,
  configureWorkItem,
  getWorkItem,
  saveCheckpoint,
  setCurrentRun,
  type WorkItemRecord,
} from "./items";
import { insertRun, type StoredRun } from "./runs";

/** Insert a queued work item. New columns keep their defaults so intake inserts stay valid. */
export function insertQueuedItem(
  db: Database,
  input: {
    id?: string;
    now?: number;
    title?: string;
    branchName?: string;
    sessionKey?: string;
    maxTurns?: number;
    maxAwakeMs?: number;
  } = {},
): WorkItemRecord {
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
  configureWorkItem(db, id, {
    sessionKey: input.sessionKey ?? "session",
    maxTurns: input.maxTurns,
    maxAwakeMs: input.maxAwakeMs,
  });
  const item = getWorkItem(db, id);
  if (item === null) throw new Error(`failed to insert ${id}`);
  return item;
}

export function beginImplementRun(
  db: Database,
  itemId: string,
  now: number,
  checkpoint?: Checkpoint,
): { item: WorkItemRecord; run: StoredRun } {
  applyWorkItemEvent(db, itemId, "dispatched");
  const run = insertRun(db, { itemId, now, status: "active", kind: "implement", agent: "cursor" });
  setCurrentRun(db, itemId, run.id);
  if (checkpoint !== undefined) saveCheckpoint(db, itemId, checkpoint);
  const item = getWorkItem(db, itemId);
  if (item === null) throw new Error(`missing ${itemId}`);
  return { item, run };
}

export function enterMergeQueue(db: Database, itemId: string, checkpoint: Checkpoint): void {
  applyWorkItemEvent(db, itemId, "turn_ended");
  applyWorkItemEvent(db, itemId, "closeout_accepted");
  saveCheckpoint(db, itemId, { ...checkpoint, phase: "merge_queue" });
}
