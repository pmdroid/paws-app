import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { isBlockerSatisfied, isTerminalWorkItemState } from "../core";
import {
  delegationHasItemWithoutSnapshot,
  delegationHasReconciliationWork,
  enqueueOutboxOnce,
  getConfirmedRemoteMerge,
  itemSpecificationPresent,
  latestIssueIdentifier,
  listBlocksOf,
  listPresentDelegationItems,
  readDependencyScope,
  readDependencySnapshot,
  saveDependencySnapshot,
  saveTaskBlocks,
  type DependencyIdentity,
  type DependencyItem,
  type DependencySnapshot,
} from "../db";
import type { DependencyEdge, LinearIssueLifecycle, TrackerAdapter } from "../linear";
import { orderByBlocks } from "./order";
import { managedBlockerSatisfied } from "./blocker-policy";

type Target = { itemId: string; workspaceId: string };
type Item = DependencyItem;
type Identity = DependencyIdentity;
type Snapshot = DependencySnapshot;
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

function scope(db: Database, target: Target): Scope | null {
  const located = itemSpecificationPresent(db, target.itemId);
  if (located === null) throw new Error("Dependency workspace or task ownership changed");
  if (located === 0) return null;
  const row = readDependencyScope(db, target.itemId, target.workspaceId);
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
  const siblings = listPresentDelegationItems(db, item.delegationId);
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
  const saved = readDependencySnapshot(db, target.itemId);
  if (saved && saved.workspaceId !== target.workspaceId)
    throw new Error("Dependency workspace or task ownership changed");
  return saved;
}

export function delegationSnapshotsComplete(db: Database, delegationId: string): boolean {
  return !delegationHasItemWithoutSnapshot(db, delegationId);
}

export function hasPendingDelegationChanges(db: Database, delegationId: string): boolean {
  return delegationHasReconciliationWork(db, delegationId);
}

export function readyItems(db: Database, target: Target): DependencyReadiness {
  return db.transaction(() => readReadyItems(db, target, false)).deferred();
}

export function canAdvanceItem(db: Database, target: Target): boolean {
  return db
    .transaction(() => readReadyItems(db, target, true).readyItemIds.includes(target.itemId))
    .deferred();
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
  const blocks = listBlocksOf(db, issueIds);
  const owned = new Set(issueIds);
  const internal = blocks.filter((edge) => owned.has(edge.blockerLinearIssueId));
  const ordered = orderByBlocks(current.siblings, internal);
  const cycleHeld = new Set(
    ordered.ok ? [] : ordered.remaining.map((entry) => entry.linearIssueId),
  );
  const satisfied = blockerSatisfied(db, target, current, saved);
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

/**
 * Identifiers of the issues that block `itemId` and that readiness counts as unmet, by the same
 * rules as `readyItems`. Empty without a dependency snapshot.
 */
export function itemBlockers(db: Database, target: Target): string[] {
  return db
    .transaction(() => {
      const current = scope(db, target);
      const saved = snapshot(db, target);
      if (!current || !saved) return [];
      const satisfied = blockerSatisfied(db, target, current, saved);
      const identifiers = new Map<string, string>(JSON.parse(saved.linearIdentifiers));
      const siblings = new Map(current.siblings.map((entry) => [entry.linearIssueId, entry]));
      const named = (id: string): string =>
        siblings.get(id)?.identifier ?? identifiers.get(id) ?? latestIssueIdentifier(db, id) ?? id;
      return listBlocksOf(db, [current.item.linearIssueId])
        .map((edge) => edge.blockerLinearIssueId)
        .filter((id) => !satisfied(id))
        .map(named);
    })
    .deferred();
}

function blockerSatisfied(
  db: Database,
  target: Target,
  current: Scope,
  saved: Snapshot,
): (id: string) => boolean {
  const states = new Map<string, string>(JSON.parse(saved.linearStates));
  const byId = new Map(current.siblings.map((entry) => [entry.linearIssueId, entry]));
  return (id: string): boolean => {
    if (states.get(id) === "canceled") return false;
    const blocker = byId.get(id);
    // A blocker outside the delegation follows its Paws work, or its Linear state without any.
    if (!blocker) return managedBlockerSatisfied(db, target, id) ?? states.get(id) === "completed";
    if (blocker.cancelRequested || blocker.state === "cancelled") return false;
    if (blocker.state === "manual") return states.get(id) === "completed";
    return isBlockerSatisfied({
      ...blocker,
      mergeSha: getConfirmedRemoteMerge(db, blocker.id)?.mergeSha ?? null,
    });
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
  } catch (caughtError1) {
    journalCaught(caughtError1, "dependencies.itemDependenciesCurrent.scope", target.itemId);
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
      saveDependencySnapshot(db, {
        itemId,
        workspaceId,
        generation: expectedGeneration + 1,
        scope: current.token,
        linearStates: JSON.stringify([...states]),
        linearIdentifiers: JSON.stringify([...identifiers]),
      });
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
