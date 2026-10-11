import type { Database } from "bun:sqlite";
import type { EpicState, WorkBrief, WorkItemState } from "../core";
import type { DependencyEdge } from "../linear";
import type { OrderNode } from "./order";
import { ulid } from "./ulid";

export type StoredEpic = {
  id: string;
  linearIssueId: string;
  linearIdentifier: string;
  title: string;
  state: EpicState;
  version: number;
};

export type StoredWorkItem = {
  id: string;
  epicId: string;
  linearIssueId: string;
  linearIdentifier: string;
  title: string;
  state: WorkItemState;
  branchName: string;
  position: number;
  version: number;
};

type EpicRow = {
  id: string;
  linear_issue_id: string;
  linear_identifier: string;
  title: string;
  state: EpicState;
  version: number;
};

type ItemRow = {
  id: string;
  epic_id: string;
  linear_issue_id: string;
  linear_identifier: string;
  title: string;
  state: WorkItemState;
  branch_name: string;
  position: number;
  version: number;
};

export function readEpicByLinearId(db: Database, linearIssueId: string): StoredEpic | null {
  const row = db
    .query<EpicRow, [string]>(
      `SELECT id, linear_issue_id, linear_identifier, title, state, version
       FROM epic WHERE linear_issue_id = ?`,
    )
    .get(linearIssueId);
  return row === null ? null : mapEpic(row);
}

export function listWorkItems(db: Database, epicId: string): StoredWorkItem[] {
  return db
    .query<ItemRow, [string]>(
      `SELECT id, epic_id, linear_issue_id, linear_identifier, title, state, branch_name, position, version
       FROM work_item WHERE epic_id = ? ORDER BY position, linear_identifier`,
    )
    .all(epicId)
    .map(mapItem);
}

export function insertRunningQueue(
  db: Database,
  input: {
    linearIssueId: string;
    identifier: string;
    title: string;
    ordered: readonly OrderNode[];
    briefs: ReadonlyMap<string, WorkBrief>;
    edges: readonly DependencyEdge[];
    now: number;
  },
): { epic: StoredEpic; items: StoredWorkItem[] } {
  const epicId = ulid(input.now);
  const items = input.ordered.map((node, position) => ({
    id: ulid(input.now + position + 1),
    epicId,
    linearIssueId: node.linearIssueId,
    linearIdentifier: node.identifier,
    title: node.title,
    state: "queued" as const,
    branchName: branchName(node.identifier),
    position,
    version: 0,
  }));
  const inQueue = new Set(items.map((item) => item.linearIssueId));
  const write = db.transaction(() => {
    db.run(
      `INSERT INTO epic (id, linear_issue_id, linear_identifier, title, state, version, created_at)
       VALUES (?, ?, ?, ?, 'running', 0, ?)`,
      [epicId, input.linearIssueId, input.identifier, input.title, input.now],
    );
    for (const item of items) {
      db.run(
        `INSERT INTO work_item (
           id, epic_id, linear_issue_id, linear_identifier, title, state, branch_name, position, version, created_at, brief
         ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, 0, ?, ?)`,
        [
          item.id,
          item.epicId,
          item.linearIssueId,
          item.linearIdentifier,
          item.title,
          item.branchName,
          item.position,
          input.now,
          JSON.stringify(input.briefs.get(item.linearIssueId)),
        ],
      );
    }
    for (const edge of input.edges) {
      if (!inQueue.has(edge.blockerLinearIssueId) || !inQueue.has(edge.blockedLinearIssueId))
        continue;
      db.run(
        `INSERT OR IGNORE INTO work_item_block (epic_id, blocker_linear_issue_id, blocked_linear_issue_id)
         VALUES (?, ?, ?)`,
        [epicId, edge.blockerLinearIssueId, edge.blockedLinearIssueId],
      );
    }
  });
  write.immediate();
  return {
    epic: {
      id: epicId,
      linearIssueId: input.linearIssueId,
      linearIdentifier: input.identifier,
      title: input.title,
      state: "running",
      version: 0,
    },
    items,
  };
}

export function insertStalledEpic(
  db: Database,
  input: { linearIssueId: string; identifier: string; title: string; now: number },
): StoredEpic {
  const id = ulid(input.now);
  db.run(
    `INSERT INTO epic (id, linear_issue_id, linear_identifier, title, state, version, created_at)
     VALUES (?, ?, ?, ?, 'stalled', 0, ?)`,
    [id, input.linearIssueId, input.identifier, input.title, input.now],
  );
  return {
    id,
    linearIssueId: input.linearIssueId,
    linearIdentifier: input.identifier,
    title: input.title,
    state: "stalled",
    version: 0,
  };
}

function mapEpic(row: EpicRow): StoredEpic {
  return {
    id: row.id,
    linearIssueId: row.linear_issue_id,
    linearIdentifier: row.linear_identifier,
    title: row.title,
    state: row.state,
    version: row.version,
  };
}

function mapItem(row: ItemRow): StoredWorkItem {
  return {
    id: row.id,
    epicId: row.epic_id,
    linearIssueId: row.linear_issue_id,
    linearIdentifier: row.linear_identifier,
    title: row.title,
    state: row.state,
    branchName: row.branch_name,
    position: row.position,
    version: row.version,
  };
}

function branchName(identifier: string): string {
  return `paws/${identifier.toLowerCase()}`;
}
