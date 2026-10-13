import type { Database } from "bun:sqlite";
import { isTerminalWorkItemState, type WorkItemState, type TaskMode } from "../core";
import type { DependencyEdge, LinearIssueLifecycle, TrackerAdapter } from "../linear";
import { orderByBlocks } from "./order";

type Target = { epicId: string; workspaceId: string };
type Item = {
  id: string;
  linearIssueId: string;
  identifier: string;
  title: string;
  state: WorkItemState;
  cancelRequested: number;
  mode: TaskMode | null;
  brief: string | null;
};
type Snapshot = { generation: number; scope: string; linearStates: string; workspaceId: string };

export type DependencyReadiness = {
  generation: number;
  readyItemIds: string[];
  heldItemIds: string[];
  cycleHeldItemIds: string[];
};

function scope(db: Database, target: Target) {
  const identity = db
    .query<
      {
        issueId: string;
        sessionId: string;
        organizationId: string;
        clientId: string;
        appUserId: string;
        sessionGeneration: number;
        teamId: string;
        ownerActorId: string | null;
        creatorId: string | null;
      },
      [string, string]
    >(
      `SELECT e.linear_issue_id AS issueId,s.session_id AS sessionId,
       s.organization_id AS organizationId,s.oauth_client_id AS clientId,
       s.app_user_id AS appUserId,s.generation AS sessionGeneration,s.team_id AS teamId,
       t.owner_actor_id AS ownerActorId,s.creator_id AS creatorId
       FROM epic e JOIN linear_session_task t ON t.epic_id=e.id
       JOIN linear_session s ON s.session_id=t.session_id
       JOIN workspace w ON w.linear_organization_id=s.organization_id
       WHERE e.id=? AND w.id=? AND e.state IN ('running','stalled')
       AND s.current_epic_id=e.id AND s.stopped_at IS NULL
       AND s.oauth_client_id IS NOT NULL AND s.app_user_id IS NOT NULL
       AND s.team_id IS NOT NULL`,
    )
    .get(target.epicId, target.workspaceId);
  if (!identity) throw new Error("Dependency workspace or task ownership changed");
  const items = db
    .query<Item, [string]>(
      `SELECT i.id,i.linear_issue_id AS linearIssueId,i.linear_identifier AS identifier,
       i.title,i.state,i.cancel_requested AS cancelRequested,t.mode,i.brief
       FROM work_item i LEFT JOIN work_item_task t ON t.item_id=i.id
       LEFT JOIN work_item_specification p ON p.item_id=i.id
       WHERE i.epic_id=? AND COALESCE(p.present,1)=1 ORDER BY i.position,i.id`,
    )
    .all(target.epicId);
  if (new Set(items.map((item) => item.linearIssueId)).size !== items.length)
    throw new Error("Dependency task identities are incomplete");
  return {
    issueId: identity.issueId,
    items,
    token: JSON.stringify([
      target.epicId,
      target.workspaceId,
      identity,
      items.map((item) => [item.id, item.linearIssueId, item.brief]),
    ]),
  };
}

function snapshot(db: Database, target: Target): Snapshot | null {
  const saved = db
    .query<Snapshot, [string]>(
      `SELECT generation,scope,linear_states AS linearStates,workspace_id AS workspaceId
       FROM epic_dependency_snapshot WHERE epic_id=?`,
    )
    .get(target.epicId);
  if (saved && saved.workspaceId !== target.workspaceId)
    throw new Error("Dependency workspace or task ownership changed");
  return saved;
}

export function hasPendingEpicChanges(db: Database, epicId: string): boolean {
  return (
    db
      .query(
        "SELECT 1 FROM epic_reconciliation_request WHERE epic_id=? UNION ALL SELECT 1 FROM epic_reconciliation_effect WHERE epic_id=? LIMIT 1",
      )
      .get(epicId, epicId) !== null
  );
}

export function readyItems(db: Database, target: Target): DependencyReadiness {
  return db.transaction(() => readReadyItems(db, target)).deferred();
}

export function canAdvanceItem(db: Database, input: Target & { itemId: string }): boolean {
  return db
    .transaction(() => readReadyItems(db, input, input.itemId).readyItemIds.includes(input.itemId))
    .deferred();
}

function readReadyItems(db: Database, target: Target, includeItemId?: string): DependencyReadiness {
  const current = scope(db, target);
  const saved = snapshot(db, target);
  const candidates = current.items.filter(
    (item) =>
      !item.cancelRequested &&
      (item.state === "queued" ||
        (item.id === includeItemId && !isTerminalWorkItemState(item.state))),
  );
  if (!saved || saved.scope !== current.token || hasPendingEpicChanges(db, target.epicId))
    return {
      generation: saved?.generation ?? 0,
      readyItemIds: [],
      heldItemIds: candidates.map((item) => item.id),
      cycleHeldItemIds: [],
    };
  const edges = db
    .query<DependencyEdge, [string]>(
      `SELECT blocker_linear_issue_id AS blockerLinearIssueId,
       blocked_linear_issue_id AS blockedLinearIssueId FROM work_item_block WHERE epic_id=?`,
    )
    .all(target.epicId);
  const ordered = orderByBlocks(current.items, edges);
  const cycleHeld = new Set(ordered.ok ? [] : ordered.remaining.map((item) => item.linearIssueId));
  const states = new Map<string, string>(JSON.parse(saved.linearStates));
  const byId = new Map(current.items.map((item) => [item.linearIssueId, item]));
  const external = db
    .query<DependencyEdge, [string]>(
      `SELECT blocker_linear_issue_id AS blockerLinearIssueId,
       blocked_linear_issue_id AS blockedLinearIssueId FROM external_dep WHERE epic_id=?`,
    )
    .all(target.epicId);
  const satisfied = (id: string): boolean => {
    if (states.get(id) === "canceled") return false;
    const item = byId.get(id);
    if (!item) return states.get(id) === "completed";
    if (item.cancelRequested || item.state === "cancelled") return false;
    if (item.state === "manual") return states.get(id) === "completed";
    return (
      item.state === "merged" ||
      (item.state === "completed" && (item.mode === "answer" || item.mode === "artifact"))
    );
  };
  const ready = candidates.filter(
    (item) =>
      !cycleHeld.has(item.linearIssueId) &&
      [...edges, ...external].every(
        (edge) =>
          edge.blockedLinearIssueId !== item.linearIssueId || satisfied(edge.blockerLinearIssueId),
      ),
  );
  const ids = new Set(ready.map((item) => item.id));
  return {
    generation: saved.generation,
    readyItemIds: [...ids],
    heldItemIds: candidates.filter((item) => !ids.has(item.id)).map((item) => item.id),
    cycleHeldItemIds: current.items
      .filter((item) => cycleHeld.has(item.linearIssueId))
      .map((item) => item.id),
  };
}

export async function syncEpicDependencies(
  db: Database,
  input: Target & {
    expectedGeneration: number;
    tracker: Pick<TrackerAdapter, "listDeps">;
    lifecycle: Pick<LinearIssueLifecycle, "inspect">;
    signal?: AbortSignal;
  },
): Promise<DependencyReadiness> {
  const { epicId, workspaceId, expectedGeneration, tracker, lifecycle, signal } = input;
  const target = { epicId, workspaceId };
  if (
    !Number.isSafeInteger(expectedGeneration) ||
    expectedGeneration < 0 ||
    expectedGeneration === Number.MAX_SAFE_INTEGER
  )
    throw new Error("Invalid dependency snapshot generation");
  const initial = scope(db, target);
  if ((snapshot(db, target)?.generation ?? 0) !== expectedGeneration)
    throw new Error("Dependency snapshot changed");
  const ids = new Set(initial.items.map((item) => item.linearIssueId));
  const edges = new Map<string, DependencyEdge>();
  for (const id of new Set([initial.issueId, ...ids])) {
    signal?.throwIfAborted();
    for (const edge of await tracker.listDeps(id)) {
      if (
        typeof edge.blockerLinearIssueId !== "string" ||
        !edge.blockerLinearIssueId ||
        typeof edge.blockedLinearIssueId !== "string" ||
        !edge.blockedLinearIssueId
      )
        throw new Error("Linear returned an invalid dependency");
      if (ids.has(edge.blockedLinearIssueId))
        edges.set(JSON.stringify([edge.blockerLinearIssueId, edge.blockedLinearIssueId]), {
          blockerLinearIssueId: edge.blockerLinearIssueId,
          blockedLinearIssueId: edge.blockedLinearIssueId,
        });
    }
  }
  const states = new Map<string, string>();
  for (const id of new Set([...edges.values()].map((edge) => edge.blockerLinearIssueId))) {
    signal?.throwIfAborted();
    const issue = await lifecycle.inspect(id, { signal });
    if (issue.id !== id || typeof issue.stateType !== "string" || !issue.stateType)
      throw new Error("Linear returned another dependency issue");
    states.set(id, issue.stateType);
  }
  signal?.throwIfAborted();
  return db
    .transaction(() => {
      if (
        scope(db, target).token !== initial.token ||
        (snapshot(db, target)?.generation ?? 0) !== expectedGeneration
      )
        throw new Error("Dependency snapshot changed");
      db.run("DELETE FROM work_item_block WHERE epic_id=?", [epicId]);
      db.run("DELETE FROM external_dep WHERE epic_id=?", [epicId]);
      for (const edge of edges.values()) {
        const table = ids.has(edge.blockerLinearIssueId) ? "work_item_block" : "external_dep";
        db.run(
          `INSERT INTO ${table}(epic_id,blocker_linear_issue_id,blocked_linear_issue_id) VALUES(?,?,?)`,
          [epicId, edge.blockerLinearIssueId, edge.blockedLinearIssueId],
        );
      }
      db.run(
        `INSERT INTO epic_dependency_snapshot(epic_id,workspace_id,generation,scope,linear_states)
       VALUES(?,?,?,?,?) ON CONFLICT(epic_id) DO UPDATE SET
       generation=excluded.generation,scope=excluded.scope,linear_states=excluded.linear_states
       WHERE epic_dependency_snapshot.workspace_id=excluded.workspace_id`,
        [epicId, workspaceId, expectedGeneration + 1, initial.token, JSON.stringify([...states])],
      );
      return readyItems(db, target);
    })
    .immediate();
}
