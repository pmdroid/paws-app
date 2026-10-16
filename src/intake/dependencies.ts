import type { Database } from "bun:sqlite";
import { isTerminalWorkItemState, type WorkItemState, type TaskMode } from "../core";
import { saveTaskBlocks } from "../db";
import type { DependencyEdge, LinearIssueLifecycle, TrackerAdapter } from "../linear";
import { orderByBlocks } from "./order";
import {
  externalPolicyBinding,
  inspectExternalBlockers,
  managedBlockerSatisfied,
  readExternalBlockerPolicies,
  type BlockerEvidence,
  type InspectBlockerMerge,
} from "./blocker-policy";

type Target = { itemId: string; workspaceId: string };
type Item = {
  id: string;
  epicId: string;
  linearIssueId: string;
  identifier: string;
  title: string;
  state: WorkItemState;
  cancelRequested: number;
  mode: TaskMode | null;
  brief: string | null;
  projectApprovalId: string | null;
};
type Identity = {
  epicIssueId: string;
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
  externalEvidence: string;
};
type Scope = {
  item: Item;
  siblings: Item[];
  identity: Identity;
  token: string;
};

export type DependencyReadiness = {
  generation: number;
  readyItemIds: string[];
  heldItemIds: string[];
  cycleHeldItemIds: string[];
};

const itemColumns = `i.id,i.epic_id AS epicId,i.linear_issue_id AS linearIssueId,
  i.linear_identifier AS identifier,i.title,i.state,i.cancel_requested AS cancelRequested,
  t.mode,i.brief,i.project_approval_id AS projectApprovalId`;

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
      `SELECT ${itemColumns},e.linear_issue_id AS epicIssueId,s.session_id AS sessionId,
       s.organization_id AS organizationId,s.oauth_client_id AS clientId,s.app_user_id AS appUserId,
       s.generation AS sessionGeneration,s.team_id AS teamId,
       COALESCE((SELECT u.linear_user_id FROM workspace_user u
         JOIN work_item oi ON oi.owner_user_id=u.id
         WHERE oi.epic_id=e.id AND oi.session_key=s.session_id
         ORDER BY oi.created_at, oi.position, oi.id LIMIT 1),
       (SELECT oi.delegated_by FROM work_item oi
         WHERE oi.epic_id=e.id AND oi.session_key=s.session_id AND oi.delegated_by IS NOT NULL
         ORDER BY oi.created_at, oi.position, oi.id LIMIT 1), s.creator_id) AS ownerActorId,
       s.creator_id AS creatorId
       FROM work_item i JOIN epic e ON e.id=i.epic_id
       JOIN linear_session s ON s.session_id=(
         SELECT si.session_key FROM work_item si
         JOIN linear_session ls ON ls.session_id=si.session_key AND ls.stopped_at IS NULL
         WHERE si.epic_id=e.id
         ORDER BY si.created_at, si.position, si.id LIMIT 1)
       JOIN workspace w ON w.linear_organization_id=s.organization_id
       LEFT JOIN work_item_task t ON t.item_id=i.id
       LEFT JOIN work_item_specification p ON p.item_id=i.id
       WHERE i.id=? AND w.id=? AND e.state IN ('running','stalled')
       AND s.stopped_at IS NULL
       AND s.oauth_client_id IS NOT NULL AND s.app_user_id IS NOT NULL
       AND s.team_id IS NOT NULL AND COALESCE(p.present,1)=1`,
    )
    .get(target.itemId, target.workspaceId);
  if (!row) throw new Error("Dependency workspace or task ownership changed");
  const {
    epicIssueId,
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
    epicIssueId,
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
       WHERE i.epic_id=? AND COALESCE(p.present,1)=1 ORDER BY i.position,i.id`,
    )
    .all(item.epicId);
  if (new Set(siblings.map((entry) => entry.linearIssueId)).size !== siblings.length)
    throw new Error("Dependency task identities are incomplete");
  return {
    item,
    siblings,
    identity,
    token: JSON.stringify([
      item.id,
      item.epicId,
      target.workspaceId,
      {
        issueId: identity.epicIssueId,
        sessionId: identity.sessionId,
        organizationId: identity.organizationId,
        clientId: identity.clientId,
        appUserId: identity.appUserId,
        sessionGeneration: identity.sessionGeneration,
        teamId: identity.teamId,
        ownerActorId: identity.ownerActorId,
        creatorId: identity.creatorId,
      },
      siblings.map((entry) => [
        entry.id,
        entry.linearIssueId,
        entry.brief,
        entry.projectApprovalId,
      ]),
      externalPolicyBinding(db, { epicId: item.epicId, workspaceId: target.workspaceId }),
    ]),
  };
}

function snapshot(db: Database, target: Target): Snapshot | null {
  const saved = db
    .query<Snapshot, [string]>(
      `SELECT generation,scope,linear_states AS linearStates,workspace_id AS workspaceId,
       external_evidence AS externalEvidence
       FROM item_dependency_snapshot WHERE item_id=?`,
    )
    .get(target.itemId);
  if (saved && saved.workspaceId !== target.workspaceId)
    throw new Error("Dependency workspace or task ownership changed");
  return saved;
}

export function epicSnapshotsComplete(db: Database, epicId: string): boolean {
  return (
    db
      .query(
        `SELECT 1 FROM work_item i WHERE i.epic_id=? AND i.state NOT IN ('completed','merged','cancelled')
         AND NOT EXISTS(SELECT 1 FROM work_item_specification p WHERE p.item_id=i.id AND p.present=0)
         AND NOT EXISTS(SELECT 1 FROM item_dependency_snapshot s WHERE s.item_id=i.id)`,
      )
      .get(epicId) === null
  );
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
  if (!saved || saved.scope !== current.token || hasPendingEpicChanges(db, item.epicId))
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
  const evidence = JSON.parse(saved.externalEvidence) as Record<string, BlockerEvidence>;
  const policies = new Map(
    readExternalBlockerPolicies(db, { epicId: item.epicId, workspaceId: target.workspaceId }).map(
      (policy) => [policy.blockerLinearIssueId, policy],
    ),
  );
  const byId = new Map(current.siblings.map((entry) => [entry.linearIssueId, entry]));
  const satisfied = (id: string): boolean => {
    if (states.get(id) === "canceled") return false;
    const blocker = byId.get(id);
    if (!blocker || blocker.state === "manual") {
      const policy = policies.get(id);
      if (policy) {
        const proof = evidence[id];
        if (
          !proof?.satisfied ||
          proof.checkedAt > Date.now() ||
          Date.now() - proof.checkedAt >= 300_000
        )
          return false;
        return policy.outcome === "merge" || states.get(id) === "completed";
      }
      if (!blocker)
        return (
          managedBlockerSatisfied(
            db,
            { epicId: item.epicId, workspaceId: target.workspaceId },
            id,
          ) ?? states.get(id) === "completed"
        );
    }
    if (!blocker || blocker.cancelRequested || blocker.state === "cancelled") return false;
    if (blocker.state === "manual") return states.get(id) === "completed";
    return (
      blocker.state === "merged" ||
      (blocker.state === "completed" && (blocker.mode === "answer" || blocker.mode === "artifact"))
    );
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
    tracker: Pick<TrackerAdapter, "listDeps" | "listIssuePullRequests">;
    lifecycle: Pick<LinearIssueLifecycle, "inspect">;
    inspectMerge?: InspectBlockerMerge;
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
  for (const id of new Set([initial.identity.epicIssueId, ...issueIds])) {
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
  for (const id of new Set([...edges.values()].map((edge) => edge.blockerLinearIssueId))) {
    signal?.throwIfAborted();
    const issue = await lifecycle.inspect(id, { signal });
    if (issue.id !== id || typeof issue.stateType !== "string" || !issue.stateType)
      throw new Error("Linear returned another dependency issue");
    states.set(id, issue.stateType);
  }
  signal?.throwIfAborted();
  const evidence = await inspectExternalBlockers(db, {
    epicId: initial.item.epicId,
    workspaceId,
    issues: [...states.keys()],
    inspectMerge: input.inspectMerge,
    tracker,
    signal,
  });
  signal?.throwIfAborted();
  return db
    .transaction(() => {
      const current = scope(db, target);
      if (
        !current ||
        current.token !== initial.token ||
        (snapshot(db, target)?.generation ?? 0) !== expectedGeneration
      )
        throw new Error("Dependency snapshot changed");
      saveTaskBlocks(db, [initial.item.linearIssueId], [...edges.values()]);
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
          initial.token,
          JSON.stringify([...states]),
          JSON.stringify(evidence),
        ],
      );
      return readyItems(db, target);
    })
    .immediate();
}
