import type { Database } from "bun:sqlite";
import {
  delegationHasOpenWork,
  isBlockerSatisfied,
  isTerminalWorkItemState,
  parentIssueIdSql,
  type WorkItemState,
  type TaskMode,
} from "../core";
import { enqueueOutboxOnce, getConfirmedRemoteMerge, saveTaskBlocks } from "../db";
import type { DependencyEdge, LinearIssueLifecycle, TrackerAdapter } from "../linear";
import { orderByBlocks } from "./order";
import { managedBlockerSatisfied } from "./blocker-policy";

type Target = { itemId: string; workspaceId: string };
type Item = {
  id: string;
  delegationId: string;
  linearIssueId: string;
  identifier: string;
  title: string;
  state: WorkItemState;
  cancelRequested: number;
  mode: TaskMode | null;
  brief: string | null;
};
type Identity = {
  delegationIssueId: string;
  sessionId: string;
  organizationId: string;
  clientId: string;
  appUserId: string;
  sessionGeneration: number;
  teamId: string;
  ownerActorId: string | null;
  creatorId: string | null;
};
type Snapshot = {
  generation: number;
  scope: string;
  linearStates: string;
  workspaceId: string;
};
type Scope = {
  item: Item;
  siblings: Item[];
  identity: Identity;
  token: string;
};

export type DependencyReads = {
  edges: DependencyEdge[];
  states: Map<string, string>;
  identifiers: Map<string, string>;
};

export type DependencyReadiness = {
  generation: number;
  readyItemIds: string[];
  heldItemIds: string[];
  cycleHeldItemIds: string[];
};

const itemColumns = `i.id,i.delegation_id AS delegationId,i.linear_issue_id AS linearIssueId,
  i.linear_identifier AS identifier,i.title,i.state,i.cancel_requested AS cancelRequested,
  t.mode,i.brief`;

function scope(db: Database, target: Target): Scope | null {
  const located = db
    .query<{ present: number }, [string]>(
      `SELECT COALESCE(p.present,1) AS present FROM work_item i
       LEFT JOIN work_item_specification p ON p.item_id=i.id WHERE i.id=?`,
    )
    .get(target.itemId);
  if (!located) throw new Error("Dependency workspace or task ownership changed");
  if (located.present === 0) return null;
  const row = db
    .query<Item & Identity, [string, string]>(
      `SELECT ${itemColumns},${parentIssueIdSql("i")} AS delegationIssueId,s.session_id AS sessionId,
       s.organization_id AS organizationId,s.oauth_client_id AS clientId,s.app_user_id AS appUserId,
       s.generation AS sessionGeneration,s.team_id AS teamId,
       COALESCE((SELECT u.linear_user_id FROM workspace_user u
         JOIN work_item oi ON oi.owner_user_id=u.id
         WHERE oi.delegation_id=i.delegation_id AND oi.session_key=s.session_id
         ORDER BY oi.created_at, oi.position, oi.id LIMIT 1),
       (SELECT oi.delegated_by FROM work_item oi
         WHERE oi.delegation_id=i.delegation_id AND oi.session_key=s.session_id AND oi.delegated_by IS NOT NULL
         ORDER BY oi.created_at, oi.position, oi.id LIMIT 1), s.creator_id) AS ownerActorId,
       s.creator_id AS creatorId
       FROM work_item i
       JOIN linear_session s ON s.session_id=(
         SELECT si.session_key FROM work_item si
         JOIN linear_session ls ON ls.session_id=si.session_key AND ls.stopped_at IS NULL
         WHERE si.delegation_id=i.delegation_id
         ORDER BY si.created_at, si.position, si.id LIMIT 1)
       JOIN workspace w ON w.linear_organization_id=s.organization_id
       LEFT JOIN work_item_task t ON t.item_id=i.id
       LEFT JOIN work_item_specification p ON p.item_id=i.id
       WHERE i.id=? AND w.id=? AND ${delegationHasOpenWork("i.delegation_id")}
       AND s.stopped_at IS NULL
       AND s.oauth_client_id IS NOT NULL AND s.app_user_id IS NOT NULL
       AND s.team_id IS NOT NULL AND COALESCE(p.present,1)=1`,
    )
    .get(target.itemId, target.workspaceId);
  if (!row) throw new Error("Dependency workspace or task ownership changed");
  const {
    delegationIssueId,
    sessionId,
    organizationId,
    clientId,
    appUserId,
    sessionGeneration,
    teamId,
    ownerActorId,
    creatorId,
    ...item
  } = row;
  const identity: Identity = {
    delegationIssueId,
    sessionId,
    organizationId,
    clientId,
    appUserId,
    sessionGeneration,
    teamId,
    ownerActorId,
    creatorId,
  };
  const siblings = db
    .query<Item, [string]>(
      `SELECT ${itemColumns} FROM work_item i
       LEFT JOIN work_item_task t ON t.item_id=i.id
       LEFT JOIN work_item_specification p ON p.item_id=i.id
       WHERE i.delegation_id=? AND COALESCE(p.present,1)=1 ORDER BY i.position,i.id`,
    )
    .all(item.delegationId);
  if (new Set(siblings.map((entry) => entry.linearIssueId)).size !== siblings.length)
    throw new Error("Dependency task identities are incomplete");
  return {
    item,
    siblings,
    identity,
    token: JSON.stringify([
      item.id,
      item.delegationId,
      target.workspaceId,
      {
        issueId: identity.delegationIssueId,
        sessionId: identity.sessionId,
        organizationId: identity.organizationId,
        clientId: identity.clientId,
        appUserId: identity.appUserId,
        sessionGeneration: identity.sessionGeneration,
        teamId: identity.teamId,
        ownerActorId: identity.ownerActorId,
        creatorId: identity.creatorId,
      },
      siblings.map((entry) => [entry.id, entry.linearIssueId, entry.brief]),
    ]),
  };
}

function snapshot(db: Database, target: Target): Snapshot | null {
  const saved = db
    .query<Snapshot, [string]>(
      `SELECT generation,scope,linear_states AS linearStates,workspace_id AS workspaceId
       FROM item_dependency_snapshot WHERE item_id=?`,
    )
    .get(target.itemId);
  if (saved && saved.workspaceId !== target.workspaceId)
    throw new Error("Dependency workspace or task ownership changed");
  return saved;
}

export function delegationSnapshotsComplete(db: Database, delegationId: string): boolean {
  return (
    db
      .query(
        `SELECT 1 FROM work_item i WHERE i.delegation_id=? AND i.state NOT IN ('completed','merged','cancelled')
         AND NOT EXISTS(SELECT 1 FROM work_item_specification p WHERE p.item_id=i.id AND p.present=0)
         AND NOT EXISTS(SELECT 1 FROM item_dependency_snapshot s WHERE s.item_id=i.id)`,
      )
      .get(delegationId) === null
  );
}

export function hasPendingDelegationChanges(db: Database, delegationId: string): boolean {
  return (
    db
      .query(
        `SELECT 1 FROM item_reconciliation_request r JOIN work_item i ON i.id=r.item_id WHERE i.delegation_id=?
         UNION ALL SELECT 1 FROM item_reconciliation_effect e JOIN work_item i ON i.id=e.item_id WHERE i.delegation_id=? LIMIT 1`,
      )
      .get(delegationId, delegationId) !== null
  );
}

export function readyItems(db: Database, target: Target): DependencyReadiness {
  return db.transaction(() => readReadyItems(db, target, false)).deferred();
}

export function canAdvanceItem(db: Database, target: Target): boolean {
  return db
    .transaction(() => readReadyItems(db, target, true).readyItemIds.includes(target.itemId))
    .deferred();
}

function blocksFor(db: Database, issueIds: string[]): DependencyEdge[] {
  if (issueIds.length === 0) return [];
  return db
    .query<DependencyEdge, string[]>(
      `SELECT blocker_linear_issue_id AS blockerLinearIssueId,
       blocked_linear_issue_id AS blockedLinearIssueId FROM task_block
       WHERE blocked_linear_issue_id IN (${issueIds.map(() => "?").join(",")})`,
    )
    .all(...issueIds);
}

function readReadyItems(db: Database, target: Target, includeHeld: boolean): DependencyReadiness {
  const current = scope(db, target);
  const saved = snapshot(db, target);
  if (!current)
    return {
      generation: saved?.generation ?? 0,
      readyItemIds: [],
      heldItemIds: [],
      cycleHeldItemIds: [],
    };
  const item = current.item;
  const candidate =
    !item.cancelRequested &&
    (item.state === "queued" || (includeHeld && !isTerminalWorkItemState(item.state)));
  const held = (): DependencyReadiness => ({
    generation: saved?.generation ?? 0,
    readyItemIds: [],
    heldItemIds: candidate ? [item.id] : [],
    cycleHeldItemIds: [],
  });
  if (!saved || saved.scope !== current.token || hasPendingDelegationChanges(db, item.delegationId))
    return held();
  const issueIds = current.siblings.map((entry) => entry.linearIssueId);
  const blocks = blocksFor(db, issueIds);
  const owned = new Set(issueIds);
  const internal = blocks.filter((edge) => owned.has(edge.blockerLinearIssueId));
  const ordered = orderByBlocks(current.siblings, internal);
  const cycleHeld = new Set(
    ordered.ok ? [] : ordered.remaining.map((entry) => entry.linearIssueId),
  );
  const states = new Map<string, string>(JSON.parse(saved.linearStates));
  const byId = new Map(current.siblings.map((entry) => [entry.linearIssueId, entry]));
  const satisfied = (id: string): boolean => {
    if (states.get(id) === "canceled") return false;
    const blocker = byId.get(id);
    // A blocker outside the delegation follows its Paws work, or its Linear state without any.
    if (!blocker)
      return (
        managedBlockerSatisfied(db, { itemId: item.id, workspaceId: target.workspaceId }, id) ??
        states.get(id) === "completed"
      );
    if (blocker.cancelRequested || blocker.state === "cancelled") return false;
    if (blocker.state === "manual") return states.get(id) === "completed";
    return isBlockerSatisfied({
      ...blocker,
      mergeSha: getConfirmedRemoteMerge(db, blocker.id)?.mergeSha ?? null,
    });
  };
  const blocking = blocks.filter((edge) => edge.blockedLinearIssueId === item.linearIssueId);
  const ready =
    candidate &&
    !cycleHeld.has(item.linearIssueId) &&
    blocking.every((edge) => satisfied(edge.blockerLinearIssueId));
  return {
    generation: saved.generation,
    readyItemIds: ready ? [item.id] : [],
    heldItemIds: candidate && !ready ? [item.id] : [],
    cycleHeldItemIds: cycleHeld.has(item.linearIssueId) ? [item.id] : [],
  };
}

export async function syncItemDependencies(
  db: Database,
  input: Target & {
    expectedGeneration: number;
    tracker: Pick<TrackerAdapter, "listDeps">;
    lifecycle: Pick<LinearIssueLifecycle, "inspect">;
    signal?: AbortSignal;
  },
): Promise<DependencyReadiness> {
  const { itemId, workspaceId, expectedGeneration, tracker, lifecycle, signal } = input;
  const target = { itemId, workspaceId };
  if (
    !Number.isSafeInteger(expectedGeneration) ||
    expectedGeneration < 0 ||
    expectedGeneration === Number.MAX_SAFE_INTEGER
  )
    throw new Error("Invalid dependency snapshot generation");
  const initial = scope(db, target);
  if (!initial) throw new Error("Dependency workspace or task ownership changed");
  if ((snapshot(db, target)?.generation ?? 0) !== expectedGeneration)
    throw new Error("Dependency snapshot changed");
  const issueIds = new Set(initial.siblings.map((item) => item.linearIssueId));
  const edges = new Map<string, DependencyEdge>();
  for (const id of new Set([initial.identity.delegationIssueId, ...issueIds])) {
    signal?.throwIfAborted();
    for (const edge of await tracker.listDeps(id)) {
      if (
        typeof edge.blockerLinearIssueId !== "string" ||
        !edge.blockerLinearIssueId ||
        typeof edge.blockedLinearIssueId !== "string" ||
        !edge.blockedLinearIssueId
      )
        throw new Error("Linear returned an invalid dependency");
      if (edge.blockedLinearIssueId === initial.item.linearIssueId)
        edges.set(JSON.stringify([edge.blockerLinearIssueId, edge.blockedLinearIssueId]), {
          blockerLinearIssueId: edge.blockerLinearIssueId,
          blockedLinearIssueId: edge.blockedLinearIssueId,
        });
    }
  }
  const states = new Map<string, string>();
  const identifiers = new Map<string, string>();
  for (const id of new Set([...edges.values()].map((edge) => edge.blockerLinearIssueId))) {
    signal?.throwIfAborted();
    const issue = await lifecycle.inspect(id, { signal });
    if (issue.id !== id || typeof issue.stateType !== "string" || !issue.stateType)
      throw new Error("Linear returned another dependency issue");
    states.set(id, issue.stateType);
    identifiers.set(id, issue.identifier ?? id);
  }
  signal?.throwIfAborted();
  return writeItemDependencies(
    db,
    { ...target, expectedGeneration },
    { edges: [...edges.values()], states, identifiers },
    initial.token,
  );
}

export function recordItemDependencies(
  db: Database,
  input: Target & { expectedGeneration: number },
  reads: DependencyReads,
): DependencyReadiness {
  return writeItemDependencies(db, input, reads, null);
}

export function itemDependenciesCurrent(db: Database, target: Target): boolean {
  try {
    const current = scope(db, target);
    return current !== null && snapshot(db, target)?.scope === current.token;
  } catch {
    return false;
  }
}

function writeItemDependencies(
  db: Database,
  input: Target & { expectedGeneration: number },
  reads: DependencyReads,
  token: string | null,
): DependencyReadiness {
  const { itemId, workspaceId, expectedGeneration } = input;
  const target = { itemId, workspaceId };
  const { edges, states, identifiers } = reads;
  return db
    .transaction(() => {
      const current = scope(db, target);
      if (
        !current ||
        (token !== null && current.token !== token) ||
        (snapshot(db, target)?.generation ?? 0) !== expectedGeneration
      )
        throw new Error("Dependency snapshot changed");
      saveTaskBlocks(db, [current.item.linearIssueId], edges);
      db.run(
        `INSERT INTO item_dependency_snapshot(item_id,workspace_id,generation,scope,linear_states,external_evidence)
         VALUES(?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET
         generation=excluded.generation,scope=excluded.scope,linear_states=excluded.linear_states,
         external_evidence=excluded.external_evidence
         WHERE item_dependency_snapshot.workspace_id=excluded.workspace_id`,
        [
          itemId,
          workspaceId,
          expectedGeneration + 1,
          current.token,
          JSON.stringify([...states]),
          "{}",
        ],
      );
      const waiting = [...states]
        .filter(([, state]) => state !== "completed")
        .map(([id]) => identifiers.get(id) ?? id)
        .sort();
      if (waiting.length && current.item.state === "queued")
        enqueueOutboxOnce(db, {
          target: "linear",
          op: "activity",
          orderingKey: current.identity.sessionId,
          idempotencyKey: `waiting:${itemId}:${waiting.join(",")}`,
          payload: {
            sessionId: current.identity.sessionId,
            kind: "thought",
            body: `Waiting for ${waiting.join(", ")} before starting.`,
          },
          now: Date.now(),
        });
      return readyItems(db, target);
    })
    .immediate();
}
