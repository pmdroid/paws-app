import type { Database } from "bun:sqlite";
import {
  delegationIssueIdSql,
  isTerminalWorkItemState,
  parentTaskKeySql,
  type DelegationState,
  type WorkBrief,
  type WorkItemState,
} from "../core";
import { applyWorkItemEvent, saveTaskBlocks } from "../db";
import type { DependencyEdge } from "../linear";
import type { OrderNode } from "./order";
import { ulid } from "./ulid";

export type StoredDelegation = {
  id: string;
  linearIssueId: string;
  linearIdentifier: string;
  title: string;
  state: DelegationState;
  version: number;
};

export type StoredWorkItem = {
  id: string;
  delegationId: string;
  linearIssueId: string;
  linearIdentifier: string;
  title: string;
  state: WorkItemState;
  branchName: string;
  position: number;
  version: number;
};

type ItemRow = {
  id: string;
  delegation_id: string;
  linear_issue_id: string;
  linear_identifier: string;
  title: string;
  state: WorkItemState;
  branch_name: string;
  position: number;
  version: number;
};

type DelegationRow = {
  delegation_id: string;
  linear_identifier: string;
  title: string;
};

type ApprovalRow = {
  id: string;
  project_id: string;
  preview: string;
};

export function findAcceptedIntake(
  db: Database,
  linearIssueId: string,
  taskKey: string,
): { delegation: StoredDelegation; items: StoredWorkItem[] } | null {
  const delegated = db
    .query<DelegationRow, [string, string]>(
      `SELECT delegation_id,
              COALESCE(json_extract(brief, '$.epic.identifier'), linear_identifier) AS linear_identifier,
              COALESCE(json_extract(brief, '$.epic.title'), title) AS title
       FROM work_item
       WHERE ${delegationIssueIdSql("work_item")} = ?
         AND ${parentTaskKeySql("work_item")} = ?
       ORDER BY created_at, id
       LIMIT 1`,
    )
    .get(linearIssueId, taskKey);
  if (delegated) {
    const items = listWorkItems(db, delegated.delegation_id);
    return {
      delegation: {
        id: delegated.delegation_id,
        linearIssueId,
        linearIdentifier: delegated.linear_identifier,
        title: delegated.title,
        state: delegationState(items),
        version: 0,
      },
      items,
    };
  }
  const adopted = readAdoptedParent(db, linearIssueId);
  return adopted === null ? null : { delegation: adopted, items: [] };
}

export function stopAdoptedParent(db: Database, sessionId: string, now: number): void {
  const generation = `parent:${sessionId}`;
  db.run(
    `UPDATE project_approval_issue SET released_at = ? WHERE released_at IS NULL AND approval_id IN
       (SELECT id FROM project_approval WHERE source = 'parent' AND generation = ? AND stopped_at IS NULL)`,
    [now, generation],
  );
  db.run(
    "UPDATE project_approval SET stopped_at = ? WHERE source = 'parent' AND generation = ? AND stopped_at IS NULL",
    [now, generation],
  );
}

export function readAdoptedParent(db: Database, linearIssueId: string): StoredDelegation | null {
  const row = db
    .query<ApprovalRow, [string]>(
      `SELECT id, project_id, preview
       FROM project_approval
       WHERE source = 'parent' AND project_id = ? AND stopped_at IS NULL
       ORDER BY created_at, id
       LIMIT 1`,
    )
    .get(linearIssueId);
  return row === null ? null : delegationFromApproval(row);
}

export function listWorkItems(db: Database, delegationId: string): StoredWorkItem[] {
  return db
    .query<ItemRow, [string]>(
      `SELECT id, delegation_id, linear_issue_id, linear_identifier, title, state, branch_name, position, version
       FROM work_item WHERE delegation_id = ? ORDER BY position, linear_identifier`,
    )
    .all(delegationId)
    .map(mapItem);
}

export function insertRunningQueue(
  db: Database,
  input: {
    taskKey?: string;
    linearIssueId: string;
    identifier: string;
    title: string;
    ordered: readonly OrderNode[];
    briefs: ReadonlyMap<string, WorkBrief>;
    edges: readonly DependencyEdge[];
    now: number;
    sessionKey?: string | null;
  },
): { delegation: StoredDelegation; items: StoredWorkItem[] } {
  const delegationId = ulid(input.now);
  const items = input.ordered.map((node, position) => ({
    id: ulid(input.now + position + 1),
    delegationId,
    linearIssueId: node.linearIssueId,
    linearIdentifier: node.identifier,
    title: node.title,
    state: "queued" as const,
    branchName: branchName(node.identifier),
    position,
    version: 0,
  }));
  const blockedIssues = new Set(items.map((item) => item.linearIssueId));
  const write = db.transaction(() => {
    for (const item of items) {
      db.run(
        `INSERT INTO work_item (
           id, delegation_id, linear_issue_id, linear_identifier, title, state, branch_name, position, version, created_at, brief, task_key, session_key
         ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, 0, ?, ?, ?, ?)`,
        [
          item.id,
          item.delegationId,
          item.linearIssueId,
          item.linearIdentifier,
          item.title,
          item.branchName,
          item.position,
          input.now,
          JSON.stringify(input.briefs.get(item.linearIssueId)),
          `${input.taskKey ?? `initial:${input.linearIssueId}`}:item:${item.linearIssueId}`,
          input.sessionKey ?? null,
        ],
      );
    }
    saveTaskBlocks(
      db,
      items.map((item) => item.linearIssueId),
      input.edges.filter((edge) => blockedIssues.has(edge.blockedLinearIssueId)),
    );
  });
  write.immediate();
  return {
    delegation: {
      id: delegationId,
      linearIssueId: input.linearIssueId,
      linearIdentifier: input.identifier,
      title: input.title,
      state: delegationState(items),
      version: 0,
    },
    items,
  };
}

function mapItem(row: ItemRow): StoredWorkItem {
  return {
    id: row.id,
    delegationId: row.delegation_id,
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

function delegationState(items: readonly StoredWorkItem[]): DelegationState {
  if (items.some((item) => !isTerminalWorkItemState(item.state))) return "running";
  if (items.length > 0 && items.every((item) => item.state === "cancelled")) return "cancelled";
  return "done";
}

function delegationFromApproval(row: ApprovalRow): StoredDelegation {
  const preview = JSON.parse(row.preview) as {
    project?: { name?: unknown; identifier?: unknown };
  };
  const name = preview.project?.name;
  const identifier = preview.project?.identifier;
  return {
    id: row.id,
    linearIssueId: row.project_id,
    linearIdentifier:
      typeof identifier === "string" && identifier.length > 0 ? identifier : row.project_id,
    title: typeof name === "string" && name.length > 0 ? name : row.project_id,
    state: "done",
    version: 0,
  };
}

export function retireEmptyFailedAttempt(db: Database, issueId: string, sessionId: string): void {
  const items = db
    .query<{ id: string }, [string, string]>(
      `SELECT item.id FROM work_item item
       JOIN linear_session previous ON previous.session_id = item.session_key
       JOIN linear_session incoming ON incoming.session_id = ?
         AND incoming.organization_id = previous.organization_id
         AND incoming.oauth_client_id = previous.oauth_client_id
         AND incoming.app_user_id = previous.app_user_id
         AND incoming.team_id = previous.team_id
       WHERE item.linear_issue_id = ? AND item.session_key != incoming.session_id
         AND item.state = 'failed' AND item.cancel_requested = 1
         AND item.current_run_id IS NULL AND item.checkpoint IS NULL
         AND item.project_approval_id IS NULL
         AND json_type(item.brief, '$.epic') = 'null'
         AND NOT EXISTS (SELECT 1 FROM work_item sibling
           WHERE sibling.delegation_id = item.delegation_id AND sibling.id != item.id)
         AND NOT EXISTS (SELECT 1 FROM run WHERE item_id = item.id)
         AND NOT EXISTS (SELECT 1 FROM job
           WHERE json_extract(payload, '$.itemId') = item.id AND status IN ('pending', 'running'))
         AND NOT EXISTS (SELECT 1 FROM linear_conversation WHERE item_id = item.id AND blocked = 1)
         AND NOT EXISTS (SELECT 1 FROM linear_session_cleanup_block
           WHERE session_id = item.session_key)`,
    )
    .all(sessionId, issueId);
  for (const item of items) applyWorkItemEvent(db, item.id, "cancel");
}
