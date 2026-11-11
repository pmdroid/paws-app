import {
  activeParentSubIssueSteps,
  claimParentSubIssueSessionSteps,
  delegationHasLiveItemSteps,
  insertParentDelegationSteps,
  insertParentSubIssueSteps,
  latestIssueIdentifierSteps,
  listActiveParentDelegationIdsSteps,
  listFailedDelegationItemIdsSteps,
  listIssueBlockerItemsSteps,
  listParentSubIssuesSteps,
  moveParentSubIssueSessionSteps,
  outboxKeyExistsSteps,
  parentDelegationActiveSteps,
  parentSubIssueActiveSteps,
  parentSubIssueForSessionSteps,
  parentSubIssueIdentifierSteps,
  readParentDelegationSteps,
  setItemOwnerSteps,
  setParentDelegationErrorSteps,
  setParentSubIssueDelegationSteps,
  workspaceIssueHasOpenItemSteps,
  workspaceMemberUsable,
  applyWorkItemEventSteps,
  auditWorkspaceAccessSteps,
  deliveredLinearIssueStateSteps,
  emitJobReady,
  enqueueJobOnceSteps,
  enqueueOutboxOnceSteps,
  getLinearSessionSteps,
  listTaskBlockersSteps,
  saveTaskBlocksSteps,
  workspaceForOrganizationSteps,
  workspaceLinearMemberSteps,
  workspaceMemberSteps,
  type JobLoop,
  type Q,
  type Steps,
  sqliteDb,
} from "../db";
import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { isBlockerSatisfied } from "../core";
import type {
  AcceptedLinearEvent,
  DependencyEdge,
  EpicSnapshot,
  IntakeDecision,
  LinearIssueLifecycle,
  TrackerAdapter,
  createSessionStarter,
} from "../linear";
import type { IntakeResult } from "./intake";
import { orderByBlocks } from "./order";
import { ulid } from "./ulid";
import { parentSummaryMessage, type SummaryIssue, type SummarySubIssue } from "./parent-summary";
import { dashboardUrl } from "../dashboard-links";

/** Refusal for a Linear event on a sub-issue that already runs in another session. */
export const PARENT_REFUSAL = {
  outcome: "refused" as const,
  reason: "This issue is a sub-issue of a delegated parent and continues in its earlier session.",
};
const ACCEPTED: IntakeDecision = { outcome: "accepted" };
const QUEUE = "parent.delegations";

type Parent = {
  delegationId: string;
  workspaceId: string;
  organizationId: string;
  sessionId: string;
  ownerUserId: string;
  edges: DependencyEdge[];
  stoppedAt: number | null;
};

type SubIssue = {
  parentDelegationId: string;
  issueId: string;
  identifier: string;
  title: string;
  url: string | null;
  sessionId: string | null;
  delegationId: string | null;
};

/** A sub-issue of a delegated parent and what it still waits for before its session opens. */
export type ParentSubIssueProgress = SubIssue & { waitingFor: string[] };

/**
 * A delegated parent issue whose sub-issues each run in their own Linear session (one issue,
 * one run, one session). Intake adopts the parent; a recurring job opens each sub-issue's
 * session once its blockers finish and ends the parent's session with one summary. The parent's
 * delegation id groups the sub-issues; each sub-issue keeps its own delegation.
 */
export function createParentDelegations(input: {
  db: Database;
  tracker: Pick<TrackerAdapter, "listDeps">;
  lifecycle: Pick<LinearIssueLifecycle, "inspect">;
  /** Absent when Paws cannot open Linear sessions; parents then run in their own session. */
  startSession?: ReturnType<typeof createSessionStarter>;
  /** Re-run intake for a sub-issue session whose intake did not finish. */
  resumeSession: (sessionId: string) => Promise<void>;
  origin: string;
  now?: () => number;
}) {
  const store = sqliteDb(input.db);
  const now = input.now ?? Date.now;

  function readParentSteps(q: Q, delegationId: string): Steps<Parent | null> {
    return readParentDelegationSteps<DependencyEdge>(q, delegationId);
  }
  function readParent(delegationId: string): Promise<Parent | null> {
    return store.run((q) => readParentSteps(q, delegationId));
  }
  function* eventSubIssueSteps(q: Q, event: AcceptedLinearEvent): Steps<SubIssue | null> {
    if (!event.issueId || !event.sessionId) return null;
    const organizationId = (yield* getLinearSessionSteps(q, event.sessionId))?.organizationId;
    return organizationId
      ? yield* activeParentSubIssueSteps(q, event.issueId, organizationId)
      : null;
  }
  function* ownerLinearUserIdSteps(q: Q, parent: Parent): Steps<string | undefined> {
    return (yield* workspaceMemberSteps(q, parent.workspaceId, parent.ownerUserId))?.linearUserId;
  }
  function* ownerCanActSteps(q: Q, parent: Parent): Steps<boolean> {
    const owner = yield* workspaceMemberSteps(q, parent.workspaceId, parent.ownerUserId);
    return !!workspaceMemberUsable(owner);
  }
  function* refuseSteps(
    q: Q,
    parent: Parent,
    event: AcceptedLinearEvent,
    reason = PARENT_REFUSAL.reason,
  ) {
    yield* auditWorkspaceAccessSteps(q, {
      workspaceId: parent.workspaceId,
      userId: null,
      action: "access.denied",
      subject: `parent.event:${event.dedupeKey}`,
      now: now(),
    });
    return { outcome: "refused" as const, reason };
  }
  /** A sub-issue whose earlier attempt failed may start again in a new session. */
  function* restartableSteps(q: Q, parent: Parent, sub: SubIssue): Steps<boolean> {
    return (
      parent.stoppedAt === null &&
      sub.delegationId !== null &&
      !(yield* delegationHasLiveItemSteps(q, sub.delegationId))
    );
  }
  function* scopeSteps(q: Q, sessionId: string, snapshot: EpicSnapshot): Steps<EpicSnapshot> {
    const sub = yield* parentSubIssueForSessionSteps(q, sessionId);
    if (!sub) {
      const organizationId = (yield* getLinearSessionSteps(q, sessionId))?.organizationId;
      if (
        organizationId &&
        (yield* activeParentSubIssueSteps(q, snapshot.linearIssueId, organizationId))
      )
        throw new Error("This issue already runs as a sub-issue of a delegated parent.");
      return snapshot;
    }
    if (snapshot.linearIssueId !== sub.issueId)
      throw new Error("This session belongs to another sub-issue of the delegated parent.");
    return { ...snapshot, subIssues: [] };
  }
  function* authorizeIntakeSteps(q: Q, sessionId: string, snapshot: EpicSnapshot): Steps<boolean> {
    try {
      yield* scopeSteps(q, sessionId, snapshot);
      return true;
    } catch (caughtError1) {
      journalCaught(caughtError1, "parent-delegation.authorizeIntake.scope", null);
      return false;
    }
  }
  function* actorSteps(q: Q, sessionId: string): Steps<string | undefined> {
    const sub = yield* parentSubIssueForSessionSteps(q, sessionId);
    const parent = sub ? yield* readParentSteps(q, sub.parentDelegationId) : null;
    return parent ? yield* ownerLinearUserIdSteps(q, parent) : undefined;
  }
  function* acceptedSteps(q: Q, sessionId: string, result: IntakeResult): Steps<void> {
    const sub = yield* parentSubIssueForSessionSteps(q, sessionId);
    if (!sub) return;
    const parent = (yield* readParentSteps(q, sub.parentDelegationId))!;
    if (!result.ok || result.items.length !== 1 || result.items[0]?.linearIssueId !== sub.issueId)
      throw new Error("Intake did not keep the sub-issue to itself.");
    yield* setItemOwnerSteps(q, result.items[0].id, parent.ownerUserId);
    yield* setParentSubIssueDelegationSteps(q, sessionId, result.delegation.id);
  }
  function* blockerSatisfiedSteps(q: Q, parent: Parent, blockerId: string): Steps<boolean> {
    const items = yield* listIssueBlockerItemsSteps(q, parent.workspaceId, blockerId);
    if (items.length > 0) {
      const active = items.filter((item) => !item.cancelRequested);
      const item = (active.length > 0 ? active : items).at(-1)!;
      return !item.cancelRequested && isBlockerSatisfied(item);
    }
    const delivered = yield* deliveredLinearIssueStateSteps(q, parent.organizationId, blockerId);
    if (delivered?.stateType) return delivered.stateType === "completed";
    return !(yield* parentSubIssueActiveSteps(q, parent.workspaceId, blockerId));
  }
  function* pendingBlockersSteps(q: Q, parent: Parent, issueId: string): Steps<string[]> {
    const blockers = new Set([
      ...parent.edges
        .filter((edge) => edge.blockedLinearIssueId === issueId)
        .map((edge) => edge.blockerLinearIssueId),
      ...(yield* listTaskBlockersSteps(q, issueId)),
    ]);
    const pending: string[] = [];
    for (const blockerId of blockers)
      if (!(yield* blockerSatisfiedSteps(q, parent, blockerId))) pending.push(blockerId);
    return pending;
  }
  function* identifierForSteps(q: Q, parent: Parent, issueId: string): Steps<string> {
    return (
      (yield* parentSubIssueIdentifierSteps(q, parent.delegationId, issueId)) ??
      (yield* latestIssueIdentifierSteps(q, issueId)) ??
      (yield* deliveredLinearIssueStateSteps(q, parent.organizationId, issueId))?.identifier ??
      issueId
    );
  }
  function* waitingForSteps(q: Q, parent: Parent, issueId: string): Steps<string[]> {
    const waiting: string[] = [];
    for (const blockerId of yield* pendingBlockersSteps(q, parent, issueId))
      waiting.push(yield* identifierForSteps(q, parent, blockerId));
    return waiting.sort();
  }
  /**
   * End the parent's own session with one response once its sub-issue sessions are open:
   * each sub-issue, whether it started, and the unfinished issues it waits for.
   */
  async function summarize(parent: Parent, signal: AbortSignal) {
    const key = `parent-summary:${parent.delegationId}`;
    if (await store.run((q) => outboxKeyExistsSteps(q, key))) return;
    const subs = await store.run((q) => listParentSubIssuesSteps(q, parent.delegationId));
    const own = new Map(subs.map((sub) => [sub.issueId, sub]));
    const outside = new Map<string, SummaryIssue | null>();
    const lines: SummarySubIssue[] = [];
    for (const sub of subs) {
      const pending = await store.run((q) => pendingBlockersSteps(q, parent, sub.issueId));
      const blockers: SummaryIssue[] = [];
      for (const edge of parent.edges) {
        if (
          edge.blockedLinearIssueId !== sub.issueId ||
          !pending.includes(edge.blockerLinearIssueId)
        )
          continue;
        const blocker = own.get(edge.blockerLinearIssueId);
        if (blocker) blockers.push({ identifier: blocker.identifier, url: blocker.url });
      }
      const external: SummaryIssue[] = [];
      for (const edge of await input.tracker.listDeps(sub.issueId)) {
        const blockerId = edge.blockerLinearIssueId;
        if (edge.blockedLinearIssueId !== sub.issueId || own.has(blockerId)) continue;
        if (!outside.has(blockerId)) {
          const read = await input.lifecycle.inspect(blockerId, { signal });
          outside.set(
            blockerId,
            ["completed", "canceled"].includes(read.stateType)
              ? null
              : { identifier: read.identifier ?? blockerId, url: read.url ?? null },
          );
        }
        const blocker = outside.get(blockerId);
        if (blocker && !external.some((entry) => entry.identifier === blocker.identifier))
          external.push(blocker);
      }
      signal.throwIfAborted();
      for (const blockerId of pending)
        if (!own.has(blockerId) && !outside.get(blockerId))
          external.push({
            identifier: await store.run((q) => identifierForSteps(q, parent, blockerId)),
            url: null,
          });
      external.sort((left, right) => left.identifier.localeCompare(right.identifier));
      lines.push({
        identifier: sub.identifier,
        title: sub.title,
        url: sub.url,
        blockers: [...blockers, ...external],
      });
    }
    if (!lines.length) return;
    await store.transaction(function* (q) {
      if ((yield* readParentSteps(q, parent.delegationId))?.stoppedAt !== null) return;
      yield* enqueueOutboxOnceSteps(q, {
        target: "linear",
        op: "activity",
        orderingKey: parent.sessionId,
        idempotencyKey: key,
        payload: {
          sessionId: parent.sessionId,
          kind: "response",
          body: parentSummaryMessage(lines),
          id: crypto.randomUUID(),
        },
        now: now(),
      });
    });
  }
  async function advance(
    parent: Parent,
    context: { signal: AbortSignal; isCurrent(): Promise<boolean> },
  ) {
    const startSession = input.startSession;
    if (!startSession) return;
    if (!(await store.run((q) => ownerCanActSteps(q, parent))))
      throw new Error("The person who delegated the parent no longer has workspace access.");
    for (const sub of await store.run((q) => listParentSubIssuesSteps(q, parent.delegationId))) {
      context.signal.throwIfAborted();
      if (sub.sessionId) {
        if (!sub.delegationId) await input.resumeSession(sub.sessionId);
        continue;
      }
      if ((await store.run((q) => waitingForSteps(q, parent, sub.issueId))).length > 0) continue;
      await startSession(
        { kind: "issue", id: sub.issueId },
        dashboardUrl(input.origin),
        context.signal,
        async (event) => {
          if (!(await context.isCurrent())) throw new Error("The parent delegation claim changed.");
          if (event.issueId !== sub.issueId || !event.sessionId)
            throw new Error("Linear returned another sub-issue.");
          const sessionId = event.sessionId;
          const changed = await store.run((q) =>
            claimParentSubIssueSessionSteps(q, parent.delegationId, sub.issueId, sessionId),
          );
          if (changed !== 1) throw new Error("This sub-issue already has a session.");
        },
      );
    }
    await summarize((await readParent(parent.delegationId))!, context.signal);
  }

  function* adoptParentSteps(
    q: Q,
    sessionId: string,
    snapshot: EpicSnapshot,
    edges: readonly DependencyEdge[],
  ): Steps<boolean> {
    if (!input.startSession) return false;
    const session = yield* getLinearSessionSteps(q, sessionId);
    if (!session?.organizationId || !session.creatorId) return false;
    const workspace = yield* workspaceForOrganizationSteps(q, session.organizationId);
    if (!workspace) return false;
    if (yield* parentDelegationActiveSteps(q, workspace.id, snapshot.linearIssueId)) return true;
    const owner = yield* workspaceLinearMemberSteps(q, workspace.id, session.creatorId);
    if (!workspaceMemberUsable(owner)) return false;
    const issueIds = snapshot.subIssues.map((issue) => issue.linearIssueId);
    for (const issueId of issueIds)
      if (
        (yield* parentSubIssueActiveSteps(q, workspace.id, issueId)) ||
        (yield* workspaceIssueHasOpenItemSteps(q, workspace.id, issueId))
      )
        return false;
    const subIds = new Set(issueIds);
    const internal = edges.filter(
      (edge) => subIds.has(edge.blockerLinearIssueId) && subIds.has(edge.blockedLinearIssueId),
    );
    const ordered = orderByBlocks(
      snapshot.subIssues.map((issue) => ({
        linearIssueId: issue.linearIssueId,
        identifier: issue.identifier,
        title: issue.title,
      })),
      internal,
    );
    if (!ordered.ok) return false;
    const createdAt = now();
    const delegationId = ulid(createdAt);
    yield* insertParentDelegationSteps(q, {
      delegationId,
      workspaceId: workspace.id,
      organizationId: workspace.organizationId,
      parentIssueId: snapshot.linearIssueId,
      parentIdentifier: snapshot.identifier,
      title: snapshot.title,
      sessionId,
      ownerUserId: owner.userId,
      edges: internal,
      createdAt,
    });
    const issues = new Map(snapshot.subIssues.map((issue) => [issue.linearIssueId, issue]));
    for (const [position, node] of ordered.ordered.entries()) {
      const issue = issues.get(node.linearIssueId)!;
      yield* insertParentSubIssueSteps(q, {
        parentDelegationId: delegationId,
        workspaceId: workspace.id,
        issueId: issue.linearIssueId,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url ?? null,
        position,
      });
    }
    yield* saveTaskBlocksSteps(
      q,
      issueIds,
      edges.filter((edge) => subIds.has(edge.blockedLinearIssueId)),
    );
    yield* auditWorkspaceAccessSteps(q, {
      workspaceId: workspace.id,
      userId: owner.userId,
      action: "parent.delegated",
      subject: `${delegationId}:${snapshot.linearIssueId}`,
      now: createdAt,
    });
    return true;
  }
  function* authorizeEventSteps(
    q: Q,
    event: AcceptedLinearEvent,
  ): Steps<IntakeDecision | { sub: SubIssue; parent: Parent } | undefined> {
    const sub = yield* eventSubIssueSteps(q, event);
    if (!sub) return undefined;
    const parent = (yield* readParentSteps(q, sub.parentDelegationId))!;
    if (sub.sessionId === event.sessionId) return ACCEPTED;
    if (event.action !== "created" || parent.stoppedAt !== null)
      return yield* refuseSteps(q, parent, event);
    if (sub.sessionId === null)
      return yield* refuseSteps(
        q,
        parent,
        event,
        `${sub.identifier} waits for its blockers under its delegated parent. Paws opens its session when they finish.`,
      );
    if (!(yield* restartableSteps(q, parent, sub)))
      return yield* refuseSteps(
        q,
        parent,
        event,
        `${sub.identifier} is still running in its earlier Paws session. Paws continues there, so reply in that session to steer it.`,
      );
    return { sub, parent };
  }
  function* recheckEventSteps(q: Q, event: AcceptedLinearEvent): Steps<boolean | undefined> {
    const sub = yield* eventSubIssueSteps(q, event);
    if (!sub) return undefined;
    if (sub.sessionId === event.sessionId) return true;
    yield* refuseSteps(q, (yield* readParentSteps(q, sub.parentDelegationId))!, event);
    return false;
  }

  return {
    adoptParentSteps,
    /** The sub-issues of a delegated parent, in blocks order, and what each waits for. */
    progress(parentDelegationId: string): Promise<ParentSubIssueProgress[]> {
      return store.run(function* (q): Steps<ParentSubIssueProgress[]> {
        const parent = yield* readParentSteps(q, parentDelegationId);
        if (!parent) return [];
        const progress: ParentSubIssueProgress[] = [];
        for (const sub of yield* listParentSubIssuesSteps(q, parentDelegationId))
          progress.push({
            ...sub,
            waitingFor: sub.sessionId ? [] : yield* waitingForSteps(q, parent, sub.issueId),
          });
        return progress;
      });
    },
    scopeSteps,
    authorizeIntakeSteps,
    actorSteps,
    acceptedSteps,
    async authorizeEvent(event: AcceptedLinearEvent): Promise<IntakeDecision | undefined> {
      const decided = await store.run((q) => authorizeEventSteps(q, event));
      if (decided === undefined || "outcome" in decided) return decided;
      const { sub, parent } = decided;
      return store.transaction(function* (q): Steps<IntakeDecision> {
        if (!(yield* restartableSteps(q, parent, sub))) return yield* refuseSteps(q, parent, event);
        for (const itemId of yield* listFailedDelegationItemIdsSteps(q, sub.delegationId!))
          yield* applyWorkItemEventSteps(q, itemId, "cancel");
        yield* moveParentSubIssueSessionSteps(q, {
          parentDelegationId: sub.parentDelegationId,
          issueId: sub.issueId,
          from: sub.sessionId!,
          to: event.sessionId!,
        });
        return ACCEPTED;
      });
    },
    recheckEvent(event: AcceptedLinearEvent): Promise<boolean | undefined> {
      return store.transaction((q) => recheckEventSteps(q, event));
    },
    scopeSnapshot(sessionId: string, snapshot: EpicSnapshot): Promise<EpicSnapshot> {
      return store.run((q) => scopeSteps(q, sessionId, snapshot));
    },
    async register(jobs: JobLoop): Promise<void> {
      if (!input.startSession) return;
      jobs.register(QUEUE, async (_job, context) => {
        for (const id of await store.run((q) => listActiveParentDelegationIdsSteps(q))) {
          context.signal.throwIfAborted();
          try {
            await advance((await readParent(id))!, context);
            await store.run((q) => setParentDelegationErrorSteps(q, id, null));
          } catch (caughtError2) {
            journalCaught(caughtError2, "parent-delegation.register.advance", null);
            context.signal.throwIfAborted();
            await store.run((q) =>
              setParentDelegationErrorSteps(
                q,
                id,
                "Sub-issue sessions could not be opened. Check Linear access.",
              ),
            );
          }
        }
      });
      const job = { queue: QUEUE, jobKey: QUEUE, recurringEveryMs: 30_000, now: now() };
      if ((await store.transaction((q) => enqueueJobOnceSteps(q, job))).inserted)
        emitJobReady(store);
    },
  };
}
