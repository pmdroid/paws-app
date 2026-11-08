import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import type { IssueBrief, WorkBrief } from "../core";
import type {
  DependencyEdge,
  EpicSnapshot,
  LinearIssueLifecycle,
  LinearSubIssue,
  TrackerAdapter,
} from "../linear";
import { readyItems, syncItemDependencies } from "./dependencies";
import { ulid } from "./ulid";
import { snapshotProject } from "./project";
import {
  clearDelegationDependencyScopes,
  countDelegationReconciliationChange,
  delegationHasOpenItem,
  delegationReconciliationChanges,
  deleteItemReconciliationEffect,
  deleteItemReconciliationRequest,
  insertIntakeItem,
  itemReconciliationDue,
  listItemReconciliationEffects,
  listItemReconciliationRequests,
  listPresentDelegationItems,
  listReconciliationItems,
  listReconciliationTargets,
  listRelationItems,
  listTaskBlockers,
  markItemSpecificationAbsent,
  readReconciliationIdentity,
  recordBlockerChecks,
  recordDelegationReconciled,
  requestItemReconciliation,
  saveItemReconciliationEffect,
  saveItemSpecification,
  saveWorkItemLinearProject,
  updateReconciledWorkItem,
} from "../db";

export const SWEEP_FULL_REFRESH_MS = 6 * 60 * 60_000;
/**
 * Linear's webhooks cover no issue relation resource, so open items' blockers are re-read this
 * often, and every `BLOCKED_RELATIONS_POLL_MS` while an item waits only on blockers.
 */
export const RELATIONS_POLL_MS = 5 * 60_000;
export const BLOCKED_RELATIONS_POLL_MS = 60_000;

export type ItemChanges = {
  delegationId: string;
  workspaceId: string;
  sessionId: string;
  addedItemIds: string[];
  removedItemIds: string[];
  specChangedItemIds: string[];
  canceledItemIds: string[];
  parentCanceled: boolean;
  issues: { itemId: string; issue: LinearSubIssue }[];
};

export type IntakeReads = { snapshot: EpicSnapshot; edges: readonly DependencyEdge[] };
export type RelationsScope = "all" | "blocked" | { itemId: string };

export class UnreadBlockersError extends Error {
  constructor() {
    super("Linear did not return this item's blockers. Try again in a moment.");
    this.name = "UnreadBlockersError";
  }
}
type Target = { itemId: string; workspaceId: string; signal?: AbortSignal; known?: IntakeReads };
type IssueChange = { issueId: string; organizationId: string; parentIssueId?: string | null };

function authority(db: Database, target: Target) {
  const row = readReconciliationIdentity(db, target.itemId, target.workspaceId);
  if (!row) throw new Error("Item reconciliation authority changed");
  const { delegationId, ...identity } = row;
  const items = listReconciliationItems(db, delegationId);
  const active = items.filter((item) => item.present !== 0);
  if (new Set(active.map((item) => item.issueId)).size !== active.length)
    throw new Error("Item reconciliation item identities are ambiguous");
  return { identity, items, delegationId, token: JSON.stringify([identity, items]) };
}

function brief(issue: LinearSubIssue | EpicSnapshot): IssueBrief {
  return {
    source: "linear",
    issueId: issue.linearIssueId,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? null,
    acceptanceCriteria: issue.acceptanceCriteria ?? null,
  };
}

function specHash(value: WorkBrief): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createItemReconciler(input: {
  db: Database;
  tracker: Pick<TrackerAdapter, "loadEpic" | "listDeps" | "listBlockers">;
  lifecycle: Pick<LinearIssueLifecycle, "inspect">;
  onChanges: (changes: ItemChanges) => void;
  afterChanges?: (changes: ItemChanges) => Promise<void>;
  scopeSnapshot?: (
    sessionId: string,
    snapshot: EpicSnapshot,
    signal?: AbortSignal,
  ) => Promise<EpicSnapshot>;
  now?: () => number;
}) {
  const { db } = input;
  const flights = new Map<string, { dirty: boolean; promise: Promise<void> }>();
  let sweepFlight: Promise<void> | null = null;
  const relationsFlights = new Map<string, Promise<Target[]>>();
  const now = input.now ?? Date.now;
  const shutdown = new AbortController();
  let closing: Promise<void> | null = null;

  async function refresh(target: Target, requestToken: string) {
    target.signal?.throwIfAborted();
    const { tracker, lifecycle } = target.known ? knownReads(target.known) : input;
    const initial = authority(db, target);
    const captured = listItemReconciliationRequests(db, initial.delegationId);
    const startedAt = now();
    const seenChanges = delegationReconciliationChanges(db, initial.delegationId);
    const loaded = await tracker.loadEpic(initial.identity.issueId);
    const snapshot = input.scopeSnapshot
      ? await input.scopeSnapshot(initial.identity.sessionId, loaded, target.signal)
      : loaded;
    target.signal?.throwIfAborted();
    if (snapshot.linearIssueId !== initial.identity.issueId)
      throw new Error("Linear returned another issue");
    const single = initial.items.every((item) => item.issueId === initial.identity.issueId);
    const issues = snapshot.subIssues.length ? snapshot.subIssues : single ? [snapshot] : [];
    if (new Set(issues.map((issue) => issue.linearIssueId)).size !== issues.length)
      throw new Error("Linear returned repeated sub-issues");
    const statuses = new Map<string, string>();
    for (const id of new Set([
      snapshot.linearIssueId,
      ...issues.map((issue) => issue.linearIssueId),
    ])) {
      const owned = await lifecycle.inspect(id, { signal: target.signal });
      if (owned.id !== id || owned.teamId !== initial.identity.teamId)
        throw new Error("Linear issue or child team changed");
      statuses.set(id, owned.stateType);
    }
    target.signal?.throwIfAborted();
    const publication = db
      .transaction(() => {
        if (authority(db, target).token !== initial.token)
          throw new Error("Item reconciliation authority changed");
        const currentRequests = listItemReconciliationRequests(db, initial.delegationId);
        if (
          JSON.stringify(currentRequests) !== JSON.stringify(captured) ||
          !currentRequests.some((row) => row.itemId === target.itemId && row.token === requestToken)
        )
          return null;
        const change: ItemChanges = {
          delegationId: initial.delegationId,
          workspaceId: target.workspaceId,
          sessionId: initial.identity.sessionId,
          addedItemIds: [],
          removedItemIds: [],
          specChangedItemIds: [],
          canceledItemIds: [],
          parentCanceled: statuses.get(snapshot.linearIssueId) === "canceled",
          issues: [],
        };
        const desired = new Set(issues.map((issue) => issue.linearIssueId));
        for (const item of initial.items) {
          if (!desired.has(item.issueId) && item.present !== 0) change.removedItemIds.push(item.id);
          if (!desired.has(item.issueId))
            markItemSpecificationAbsent(
              db,
              item.id,
              item.hash ?? specHash(JSON.parse(item.brief ?? "null")),
            );
        }
        const byIssue = new Map(
          initial.items.filter((item) => item.present !== 0).map((item) => [item.issueId, item]),
        );
        for (const [position, issue] of issues.entries()) {
          const workBrief: WorkBrief = {
            issue: brief(issue),
            epic: issue.linearIssueId === snapshot.linearIssueId ? null : brief(snapshot),
          };
          const hash = specHash(workBrief);
          const existing = byIssue.get(issue.linearIssueId);
          const id = existing?.id ?? ulid(now() + position);
          if (!existing) {
            const previousOccurrences = initial.items.filter(
              (item) => item.issueId === issue.linearIssueId,
            ).length;
            const reappearance = previousOccurrences ? `:reappearance:${previousOccurrences}` : "";
            insertIntakeItem(db, {
              id,
              delegationId: initial.delegationId,
              linearIssueId: issue.linearIssueId,
              linearIdentifier: issue.identifier,
              title: issue.title,
              branchName: `paws/${issue.identifier.toLowerCase()}${previousOccurrences ? `-r${previousOccurrences}` : ""}`,
              position,
              createdAt: now(),
              brief: JSON.stringify(workBrief),
              taskKey: `${initial.identity.taskKey ?? `initial:${snapshot.linearIssueId}`}:item:${issue.linearIssueId}${reappearance}`,
              sessionKey: initial.identity.sessionId,
            });
            change.addedItemIds.push(id);
          } else {
            const previous = existing.hash ?? specHash(JSON.parse(existing.brief ?? "null"));
            if (previous !== hash) change.specChangedItemIds.push(id);
            updateReconciledWorkItem(db, id, {
              brief: JSON.stringify(workBrief),
              title: issue.title,
              linearIdentifier: issue.identifier,
              position,
            });
          }
          saveItemSpecification(db, id, hash);
          const project = snapshotProject(issue);
          if (project !== undefined) saveWorkItemLinearProject(db, id, project);
          change.issues.push({ itemId: id, issue });
          if (change.parentCanceled || statuses.get(issue.linearIssueId) === "canceled")
            change.canceledItemIds.push(id);
        }
        if (
          change.addedItemIds.length ||
          change.removedItemIds.length ||
          change.specChangedItemIds.length
        )
          clearDelegationDependencyScopes(db, initial.delegationId);
        for (const [kind, ids] of [
          ["spec", change.specChangedItemIds],
          ["removed", change.removedItemIds],
          ["canceled", change.canceledItemIds],
        ] as const)
          for (const id of ids)
            saveItemReconciliationEffect(db, { itemId: id, kind, token: crypto.randomUUID() });
        input.onChanges({ ...change });
        const effects = listItemReconciliationEffects(db, initial.delegationId);
        change.specChangedItemIds = effects
          .filter((effect) => effect.kind === "spec")
          .map((effect) => effect.itemId);
        change.removedItemIds = effects
          .filter((effect) => effect.kind === "removed")
          .map((effect) => effect.itemId);
        change.canceledItemIds = effects
          .filter((effect) => effect.kind === "canceled")
          .map((effect) => effect.itemId);
        return { change, effects };
      })
      .immediate();
    if (publication === null) return;
    const changes = publication.change;
    await input.afterChanges?.(changes);
    target.signal?.throwIfAborted();
    if (!changes.parentCanceled && delegationHasOpenItem(db, initial.delegationId)) {
      const itemIds = listPresentDelegationItems(db, initial.delegationId).map((item) => item.id);
      for (const itemId of itemIds)
        await syncItemDependencies(db, {
          itemId,
          workspaceId: target.workspaceId,
          expectedGeneration: readyItems(db, { itemId, workspaceId: target.workspaceId })
            .generation,
          tracker,
          lifecycle,
          signal: target.signal,
        });
    }
    db.transaction(() => {
      recordDelegationReconciled(db, initial.delegationId, seenChanges, startedAt);
      for (const request of captured)
        deleteItemReconciliationRequest(db, request.itemId, target.workspaceId, request.token);
      for (const effect of publication.effects) deleteItemReconciliationEffect(db, effect);
    }).immediate();
  }

  function knownReads(known: IntakeReads) {
    const issues = new Map(
      [known.snapshot, ...known.snapshot.subIssues].map((issue) => [issue.linearIssueId, issue]),
    );
    return {
      tracker: {
        ...input.tracker,
        loadEpic: async () => known.snapshot,
        listDeps: async () => known.edges,
      },
      lifecycle: {
        inspect: async (id: string, options?: { signal?: AbortSignal }) => {
          const issue = issues.get(id);
          return issue?.teamId && issue.stateType
            ? {
                id,
                teamId: issue.teamId,
                stateType: issue.stateType,
                assigneeId: issue.assigneeId ?? null,
                delegateId: null,
              }
            : input.lifecycle.inspect(id, options);
        },
      },
    };
  }

  function waitForFlight(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      promise.then(
        () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        (error) => {
          journalCaught(error, "reconciliation.waitForFlight", null);
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  }

  function reconcile(target: Target): Promise<void> {
    if (shutdown.signal.aborted) return Promise.reject(shutdown.signal.reason);
    if (target.signal?.aborted) return Promise.reject(target.signal.reason);
    let delegationId: string;
    try {
      delegationId = db
        .transaction(() => {
          const current = authority(db, target);
          const accepted = requestItemReconciliation(
            db,
            target.itemId,
            target.workspaceId,
            crypto.randomUUID(),
          );
          if (!accepted) throw new Error("Item reconciliation workspace changed");
          return current.delegationId;
        })
        .immediate();
    } catch (error) {
      journalCaught(error, "reconciliation.reconcile.immediate", target.itemId);
      return Promise.reject(error);
    }
    const key = JSON.stringify([target.workspaceId, delegationId]);
    const existing = flights.get(key);
    if (existing) {
      existing.dirty = true;
      return waitForFlight(existing.promise, target.signal);
    }
    const flight = { dirty: false, promise: Promise.resolve() };
    flight.promise = (async () => {
      try {
        do {
          flight.dirty = false;
          const pending = listItemReconciliationRequests(db, delegationId);
          const request = pending.find((row) => row.itemId === target.itemId) ?? pending[0];
          if (!request) throw new Error("Item reconciliation request changed");
          const known = request.itemId === target.itemId ? target.known : undefined;
          target = { ...target, known: undefined };
          await refresh(
            {
              itemId: request.itemId,
              workspaceId: target.workspaceId,
              signal: shutdown.signal,
              known,
            },
            request.token,
          );
        } while (flight.dirty);
      } finally {
        flights.delete(key);
      }
    })();
    flights.set(key, flight);
    return waitForFlight(flight.promise, target.signal);
  }

  function activeTargets(issue?: IssueChange): Target[] {
    return listReconciliationTargets(db, issue);
  }

  async function issueChanged(issue: IssueChange) {
    shutdown.signal.throwIfAborted();
    if (!issue.issueId || !issue.organizationId)
      throw new Error("Missing Linear issue event identity");
    const targets = activeTargets(issue);
    db.transaction(() => {
      for (const target of targets) countDelegationReconciliationChange(db, target.itemId);
    }).immediate();
    await Promise.all(targets.map(reconcile));
    return targets;
  }

  function due(target: Target, time: number): boolean {
    return itemReconciliationDue(db, target.itemId, time - SWEEP_FULL_REFRESH_MS);
  }

  function sweep(options: { now?: number; signal?: AbortSignal } = {}): Promise<void> {
    if (shutdown.signal.aborted) return Promise.reject(shutdown.signal.reason);
    if (sweepFlight) return sweepFlight;
    const time = options.now ?? now();
    sweepFlight = (async () => {
      try {
        await Promise.all(
          activeTargets()
            .filter((target) => due(target, time))
            .map((target) => reconcile({ ...target, signal: options.signal })),
        );
      } finally {
        sweepFlight = null;
      }
    })();
    return sweepFlight;
  }

  function relationItems(scope: RelationsScope) {
    return listRelationItems(db, {
      blockedOnly: scope !== "all",
      itemId: typeof scope === "object" ? scope.itemId : undefined,
    });
  }

  async function readBlockers(items: readonly { itemId: string; issueId: string }[]) {
    const issueIds = [...new Set(items.map((item) => item.issueId))];
    const read = new Map<string, readonly string[]>();
    if (input.tracker.listBlockers) {
      if (issueIds.length) {
        try {
          for (const [id, blockers] of await input.tracker.listBlockers(issueIds))
            read.set(id, blockers);
        } catch (error) {
          journalCaught(error, "reconciliation.pollRelations.listBlockers", null);
        }
      }
      return read;
    }
    for (const item of items) {
      if (read.has(item.issueId)) continue;
      try {
        const edges = await input.tracker.listDeps(item.issueId);
        read.set(
          item.issueId,
          edges
            .filter((edge) => edge.blockedLinearIssueId === item.issueId)
            .map((edge) => edge.blockerLinearIssueId),
        );
      } catch (error) {
        journalCaught(error, "reconciliation.pollRelations.listDeps", item.itemId);
      }
    }
    return read;
  }

  function blockedItemIds(): string[] {
    return relationItems("blocked").map((item) => item.itemId);
  }

  /**
   * Reads the relations of the open items in `scope` and reconciles the delegations whose
   * blockers no longer match `task_block`. One request per poll where the tracker reads relations
   * in a batch, against the epic, child and status reads of a full reconcile.
   */
  function pollRelations(
    options: { signal?: AbortSignal; scope?: RelationsScope } = {},
  ): Promise<Target[]> {
    if (shutdown.signal.aborted) return Promise.reject(shutdown.signal.reason);
    const scope = options.scope ?? "all";
    const key = JSON.stringify(scope);
    const running = relationsFlights.get(key);
    if (running) return running;
    const flight = (async () => {
      try {
        const items = relationItems(scope);
        options.signal?.throwIfAborted();
        shutdown.signal.throwIfAborted();
        const checkedAt = now();
        const read = await readBlockers(items);
        options.signal?.throwIfAborted();
        shutdown.signal.throwIfAborted();
        recordBlockerChecks(
          db,
          items.filter((item) => read.has(item.issueId)).map((item) => item.itemId),
          checkedAt,
        );
        if (typeof scope === "object" && items.some((item) => !read.has(item.issueId)))
          throw new UnreadBlockersError();
        const changed = new Map<string, Target>();
        for (const item of items) {
          const blockers = read.get(item.issueId);
          if (!blockers || changed.has(item.delegationId)) continue;
          const saved = new Set(listTaskBlockers(db, item.issueId));
          const found = new Set(blockers);
          if (found.size !== saved.size || [...found].some((id) => !saved.has(id)))
            changed.set(item.delegationId, { itemId: item.itemId, workspaceId: item.workspaceId });
        }
        db.transaction(() => {
          for (const target of changed.values())
            countDelegationReconciliationChange(db, target.itemId);
        }).immediate();
        await Promise.all(
          [...changed.values()].map((target) => reconcile({ ...target, signal: options.signal })),
        );
        return [...changed.values()];
      } finally {
        relationsFlights.delete(key);
      }
    })();
    relationsFlights.set(key, flight);
    return flight;
  }

  function close(): Promise<void> {
    if (closing) return closing;
    shutdown.abort(new DOMException("Item reconciliation stopped", "AbortError"));
    closing = Promise.allSettled([...flights.values()].map((flight) => flight.promise)).then(
      () => undefined,
    );
    return closing;
  }

  return { reconcile, issueChanged, sweep, pollRelations, blockedItemIds, close };
}
