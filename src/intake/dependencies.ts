import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { isBlockerSatisfied, isTerminalWorkItemState } from "../core";
import {
  delegationHasItemWithoutSnapshot,
  delegationHasReconciliationWork,
  delegationHasReconciliationWorkSteps,
  enqueueOutboxOnceSteps,
  getConfirmedRemoteMergeSteps,
  itemSpecificationPresentSteps,
  latestIssueIdentifierSteps,
  listBlocksOfSteps,
  listPresentDelegationItemsSteps,
  readDependencyScopeSteps,
  readDependencySnapshotSteps,
  saveDependencySnapshotSteps,
  saveTaskBlocksSteps,
  sqliteDb,
  type Q,
  type Steps,
  type DependencyIdentity,
  type DependencyItem,
  type DependencySnapshot,
} from "../db";
import type { DependencyEdge, LinearIssueLifecycle, TrackerAdapter } from "../linear";
import { orderByBlocks } from "./order";
import { managedBlockerSatisfiedSteps } from "./blocker-policy";

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

function* scopeSteps(q: Q, target: Target): Steps<Scope | null> {
  const located = yield* itemSpecificationPresentSteps(q, target.itemId);
  if (located === null) throw new Error("Dependency workspace or task ownership changed");
  if (located === 0) return null;
  const row = yield* readDependencyScopeSteps(q, target.itemId, target.workspaceId);
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
  const siblings = yield* listPresentDelegationItemsSteps(q, item.delegationId);
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

function* snapshotSteps(q: Q, target: Target): Steps<Snapshot | null> {
  const saved = yield* readDependencySnapshotSteps(q, target.itemId);
  if (saved && saved.workspaceId !== target.workspaceId)
    throw new Error("Dependency workspace or task ownership changed");
  return saved;
}

export async function delegationSnapshotsComplete(
  db: Database,
  delegationId: string,
): Promise<boolean> {
  return !(await delegationHasItemWithoutSnapshot(sqliteDb(db), delegationId));
}

export async function hasPendingDelegationChanges(
  db: Database,
  delegationId: string,
): Promise<boolean> {
  return delegationHasReconciliationWork(sqliteDb(db), delegationId);
}

export function* readyItemsSteps(q: Q, target: Target): Steps<DependencyReadiness> {
  return yield* q.transaction((tx) => readReadyItemsSteps(tx, target, false));
}

export function* canAdvanceItemSteps(q: Q, target: Target): Steps<boolean> {
  return yield* q.transaction((tx) => canAdvanceSteps(tx, target));
}

function* canAdvanceSteps(q: Q, target: Target): Steps<boolean> {
  return (yield* readReadyItemsSteps(q, target, true)).readyItemIds.includes(target.itemId);
}

function* readReadyItemsSteps(
  q: Q,
  target: Target,
  includeHeld: boolean,
): Steps<DependencyReadiness> {
  const current = yield* scopeSteps(q, target);
  const saved = yield* snapshotSteps(q, target);
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
  if (
    !saved ||
    saved.scope !== current.token ||
    (yield* delegationHasReconciliationWorkSteps(q, item.delegationId))
  )
    return held();
  const issueIds = current.siblings.map((entry) => entry.linearIssueId);
  const blocks = yield* listBlocksOfSteps(q, issueIds);
  const owned = new Set(issueIds);
  const internal = blocks.filter((edge) => owned.has(edge.blockerLinearIssueId));
  const ordered = orderByBlocks(current.siblings, internal);
  const cycleHeld = new Set(
    ordered.ok ? [] : ordered.remaining.map((entry) => entry.linearIssueId),
  );
  const satisfied = blockerSatisfied(target, current, saved);
  const blocking = blocks.filter((edge) => edge.blockedLinearIssueId === item.linearIssueId);
  let ready = candidate && !cycleHeld.has(item.linearIssueId);
  for (const edge of blocking) {
    if (!ready) break;
    ready = yield* satisfied(q, edge.blockerLinearIssueId);
  }
  return {
    generation: saved.generation,
    readyItemIds: ready ? [item.id] : [],
    heldItemIds: candidate && !ready ? [item.id] : [],
    cycleHeldItemIds: cycleHeld.has(item.linearIssueId) ? [item.id] : [],
  };
}

export function* itemBlockersSteps(q: Q, target: Target): Steps<string[]> {
  return yield* q.transaction((tx) => readItemBlockersSteps(tx, target));
}

function* readItemBlockersSteps(q: Q, target: Target): Steps<string[]> {
  const current = yield* scopeSteps(q, target);
  const saved = yield* snapshotSteps(q, target);
  if (!current || !saved) return [];
  const satisfied = blockerSatisfied(target, current, saved);
  const identifiers = new Map<string, string>(JSON.parse(saved.linearIdentifiers));
  const siblings = new Map(current.siblings.map((entry) => [entry.linearIssueId, entry]));
  const unmet: string[] = [];
  for (const edge of yield* listBlocksOfSteps(q, [current.item.linearIssueId]))
    if (!(yield* satisfied(q, edge.blockerLinearIssueId))) unmet.push(edge.blockerLinearIssueId);
  const named: string[] = [];
  for (const id of unmet)
    named.push(
      siblings.get(id)?.identifier ??
        identifiers.get(id) ??
        (yield* latestIssueIdentifierSteps(q, id)) ??
        id,
    );
  return named;
}

function blockerSatisfied(
  target: Target,
  current: Scope,
  saved: Snapshot,
): (q: Q, id: string) => Steps<boolean> {
  const states = new Map<string, string>(JSON.parse(saved.linearStates));
  const byId = new Map(current.siblings.map((entry) => [entry.linearIssueId, entry]));
  return function* (q, id) {
    // A blocker cancelled in Linear no longer blocks, the same as a completed one.
    if (states.get(id) === "canceled") return true;
    const blocker = byId.get(id);
    // A blocker outside the delegation follows its Paws work, or its Linear state without any.
    if (!blocker)
      return (yield* managedBlockerSatisfiedSteps(q, target, id)) ?? states.get(id) === "completed";
    if (blocker.cancelRequested || blocker.state === "cancelled") return false;
    if (blocker.state === "manual") return states.get(id) === "completed";
    const merge = yield* getConfirmedRemoteMergeSteps(q, blocker.id);
    return isBlockerSatisfied({ ...blocker, mergeSha: merge?.mergeSha ?? null });
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
  const store = sqliteDb(db);
  const initial = await store.run((q) => scopeSteps(q, target));
  if (!initial) throw new Error("Dependency workspace or task ownership changed");
  if (((await store.run((q) => snapshotSteps(q, target)))?.generation ?? 0) !== expectedGeneration)
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
  return store.transaction((q) =>
    writeItemDependenciesSteps(
      q,
      { ...target, expectedGeneration },
      { edges: [...edges.values()], states, identifiers },
      initial.token,
    ),
  );
}

export function* recordItemDependenciesSteps(
  q: Q,
  input: Target & { expectedGeneration: number },
  reads: DependencyReads,
): Steps<DependencyReadiness> {
  return yield* q.transaction((tx) => writeItemDependenciesSteps(tx, input, reads, null));
}

export function* itemDependenciesCurrentSteps(q: Q, target: Target): Steps<boolean> {
  try {
    const current = yield* scopeSteps(q, target);
    return current !== null && (yield* snapshotSteps(q, target))?.scope === current.token;
  } catch (caughtError1) {
    journalCaught(caughtError1, "dependencies.itemDependenciesCurrent.scope", target.itemId);
    return false;
  }
}

function* writeItemDependenciesSteps(
  q: Q,
  input: Target & { expectedGeneration: number },
  reads: DependencyReads,
  token: string | null,
): Steps<DependencyReadiness> {
  const { itemId, workspaceId, expectedGeneration } = input;
  const target = { itemId, workspaceId };
  const { edges, states, identifiers } = reads;
  const current = yield* scopeSteps(q, target);
  if (
    !current ||
    (token !== null && current.token !== token) ||
    ((yield* snapshotSteps(q, target))?.generation ?? 0) !== expectedGeneration
  )
    throw new Error("Dependency snapshot changed");
  yield* q.transaction((tx) => saveTaskBlocksSteps(tx, [current.item.linearIssueId], edges));
  yield* saveDependencySnapshotSteps(q, {
    itemId,
    workspaceId,
    generation: expectedGeneration + 1,
    scope: current.token,
    linearStates: JSON.stringify([...states]),
    linearIdentifiers: JSON.stringify([...identifiers]),
  });
  const waiting = [...states]
    .filter(([, state]) => state !== "completed" && state !== "canceled")
    .map(([id]) => identifiers.get(id) ?? id)
    .sort();
  if (waiting.length && current.item.state === "queued")
    yield* q.transaction((tx) =>
      enqueueOutboxOnceSteps(tx, {
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
      }),
    );
  return yield* readyItemsSteps(q, target);
}
