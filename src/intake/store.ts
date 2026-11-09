import type { Database } from "bun:sqlite";
import {
  isTerminalWorkItemState,
  type DelegationState,
  type WorkBrief,
  type WorkItemState,
} from "../core";
import {
  applyWorkItemEvent,
  emptyFailedAttempts,
  insertItemContinuation,
  insertIntakeItem,
  listDelegationItems,
  readActiveParentDelegation,
  readDelegatedIntake,
  readUnlandedAttempt,
  saveTaskBlocks,
  saveWorkItemLinearProject,
  stopSessionParentDelegation,
  type WorkItemLinearProject,
} from "../db";
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

export function findAcceptedIntake(
  db: Database,
  linearIssueId: string,
  taskKey: string,
): { delegation: StoredDelegation; items: StoredWorkItem[] } | null {
  const delegated = readDelegatedIntake(db, linearIssueId, taskKey);
  if (delegated) {
    const items = listWorkItems(db, delegated.delegationId);
    return {
      delegation: {
        id: delegated.delegationId,
        linearIssueId,
        linearIdentifier: delegated.linearIdentifier,
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

/** Stop the parent delegation a session adopted and release its sub-issues. */
export function stopAdoptedParent(db: Database, sessionId: string, now: number): void {
  stopSessionParentDelegation(db, sessionId, now);
}

/** The active delegation of a parent issue whose sub-issues each run in their own session. */
export function readAdoptedParent(db: Database, linearIssueId: string): StoredDelegation | null {
  const row = readActiveParentDelegation(db, linearIssueId);
  return row === null
    ? null
    : {
        id: row.delegationId,
        linearIssueId: row.parentIssueId,
        linearIdentifier: row.parentIdentifier,
        title: row.title,
        state: "done",
        version: 0,
      };
}

export function listWorkItems(db: Database, delegationId: string): StoredWorkItem[] {
  return listDelegationItems(db, delegationId);
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
    /** Each issue's Linear project from the intake snapshot. Missing issues keep none. */
    projects?: ReadonlyMap<string, WorkItemLinearProject | null>;
    edges: readonly DependencyEdge[];
    now: number;
    sessionKey?: string | null;
    /** Issues whose earlier item's branch and pull request the new item takes over. */
    continuations?: ReadonlyMap<string, EarlierAttempt>;
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
    branchName:
      input.continuations?.get(node.linearIssueId)?.branchName ?? branchName(node.identifier),
    position,
    version: 0,
  }));
  const blockedIssues = new Set(items.map((item) => item.linearIssueId));
  const write = db.transaction(() => {
    for (const item of items) {
      insertIntakeItem(db, {
        id: item.id,
        delegationId: item.delegationId,
        linearIssueId: item.linearIssueId,
        linearIdentifier: item.linearIdentifier,
        title: item.title,
        branchName: item.branchName,
        position: item.position,
        createdAt: input.now,
        brief: JSON.stringify(input.briefs.get(item.linearIssueId)),
        taskKey: `${input.taskKey ?? `initial:${input.linearIssueId}`}:item:${item.linearIssueId}`,
        sessionKey: input.sessionKey ?? null,
      });
      const continued = input.continuations?.get(item.linearIssueId);
      if (continued) insertItemContinuation(db, item.id, continued.itemId, continued.branchName);
      const project = input.projects?.get(item.linearIssueId);
      if (project) saveWorkItemLinearProject(db, item.id, project);
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

/** An earlier item of an issue that a new delegation may continue. */
export type EarlierAttempt = {
  itemId: string;
  linearIssueId: string;
  linearIdentifier: string;
  /** The branch the earlier item pushed, `paws/<key>`. */
  branchName: string;
};

/**
 * The latest earlier item of the issue that ran and did not land: its branch may hold work a
 * new delegation continues. Merged and completed items leave nothing to continue.
 */
export function readEarlierAttempt(db: Database, linearIssueId: string): EarlierAttempt | null {
  const row = readUnlandedAttempt(db, linearIssueId);
  return row === null
    ? null
    : {
        itemId: row.id,
        linearIssueId,
        linearIdentifier: row.linearIdentifier,
        branchName: row.branchName,
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

export function retireEmptyFailedAttempt(db: Database, issueId: string, sessionId: string): void {
  for (const id of emptyFailedAttempts(db, issueId, sessionId))
    applyWorkItemEvent(db, id, "cancel");
}
