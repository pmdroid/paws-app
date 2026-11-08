import {
  activeParentSubIssue,
  claimParentSubIssueSession,
  delegationHasLiveItem,
  insertParentDelegation,
  insertParentSubIssue,
  latestIssueIdentifier,
  listActiveParentDelegationIds,
  listFailedDelegationItemIds,
  listIssueBlockerItems,
  listParentSubIssues,
  moveParentSubIssueSession,
  outboxKeyExists,
  parentDelegationActive,
  parentSubIssueActive,
  parentSubIssueForSession,
  parentSubIssueIdentifier,
  readParentDelegation,
  setItemOwner,
  setParentDelegationError,
  setParentSubIssueDelegation,
  workspaceIssueHasOpenItem,
  workspaceMemberUsable,
  applyWorkItemEvent,
  auditWorkspaceAccess,
  deliveredLinearIssueState,
  enqueueJobOnce,
  enqueueOutboxOnce,
  getLinearSession,
  immediate,
  listTaskBlockers,
  saveTaskBlocks,
  workspaceForOrganization,
  workspaceLinearMember,
  workspaceMember,
  type JobLoop,
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
  const { db } = input;
  const now = input.now ?? Date.now;

  function readParent(delegationId: string): Parent | null {
    return readParentDelegation<DependencyEdge>(db, delegationId);
  }
  function subIssues(parentDelegationId: string): SubIssue[] {
    return listParentSubIssues(db, parentDelegationId);
  }
  function subIssueForSession(sessionId: string): SubIssue | null {
    return parentSubIssueForSession(db, sessionId);
  }
  function activeSubIssue(issueId: string, organizationId: string): SubIssue | null {
    return activeParentSubIssue(db, issueId, organizationId);
  }
  function eventSubIssue(event: AcceptedLinearEvent): SubIssue | null {
    if (!event.issueId || !event.sessionId) return null;
    const organizationId = getLinearSession(db, event.sessionId)?.organizationId;
    return organizationId ? activeSubIssue(event.issueId, organizationId) : null;
  }
  function ownerLinearUserId(parent: Parent): string | undefined {
    return workspaceMember(db, parent.workspaceId, parent.ownerUserId)?.linearUserId;
  }
  function ownerCanAct(parent: Parent): boolean {
    const owner = workspaceMember(db, parent.workspaceId, parent.ownerUserId);
    return !!workspaceMemberUsable(owner);
  }
  function refuse(parent: Parent, event: AcceptedLinearEvent, reason = PARENT_REFUSAL.reason) {
    auditWorkspaceAccess(db, {
      workspaceId: parent.workspaceId,
      userId: null,
      action: "access.denied",
      subject: `parent.event:${event.dedupeKey}`,
      now: now(),
    });
    return { outcome: "refused" as const, reason };
  }
  /** A sub-issue whose earlier attempt failed may start again in a new session. */
  function restartable(parent: Parent, sub: SubIssue): boolean {
    return (
      parent.stoppedAt === null &&
      sub.delegationId !== null &&
      !delegationHasLiveItem(db, sub.delegationId)
    );
  }
  function scope(sessionId: string, snapshot: EpicSnapshot): EpicSnapshot {
    const sub = subIssueForSession(sessionId);
    if (!sub) {
      const organizationId = getLinearSession(db, sessionId)?.organizationId;
      if (organizationId && activeSubIssue(snapshot.linearIssueId, organizationId))
        throw new Error("This issue already runs as a sub-issue of a delegated parent.");
      return snapshot;
    }
    if (snapshot.linearIssueId !== sub.issueId)
      throw new Error("This session belongs to another sub-issue of the delegated parent.");
    return { ...snapshot, subIssues: [] };
  }
  function blockerSatisfied(parent: Parent, blockerId: string): boolean {
    const items = listIssueBlockerItems(db, parent.workspaceId, blockerId);
    if (items.length > 0) {
      const active = items.filter((item) => !item.cancelRequested);
      const item = (active.length > 0 ? active : items).at(-1)!;
      return !item.cancelRequested && isBlockerSatisfied(item);
    }
    const delivered = deliveredLinearIssueState(db, parent.organizationId, blockerId);
    if (delivered?.stateType) return delivered.stateType === "completed";
    return !parentSubIssueActive(db, parent.workspaceId, blockerId);
  }
  function pendingBlockers(parent: Parent, issueId: string): string[] {
    const blockers = new Set([
      ...parent.edges
        .filter((edge) => edge.blockedLinearIssueId === issueId)
        .map((edge) => edge.blockerLinearIssueId),
      ...listTaskBlockers(db, issueId),
    ]);
    return [...blockers].filter((blockerId) => !blockerSatisfied(parent, blockerId));
  }
  function identifierFor(parent: Parent, issueId: string): string {
    return (
      parentSubIssueIdentifier(db, parent.delegationId, issueId) ??
      latestIssueIdentifier(db, issueId) ??
      deliveredLinearIssueState(db, parent.organizationId, issueId)?.identifier ??
      issueId
    );
  }
  function waitingFor(parent: Parent, issueId: string): string[] {
    return pendingBlockers(parent, issueId)
      .map((blockerId) => identifierFor(parent, blockerId))
      .sort();
  }
  /**
   * End the parent's own session with one response once its sub-issue sessions are open:
   * each sub-issue, whether it started, and the unfinished issues it waits for.
   */
  async function summarize(parent: Parent, signal: AbortSignal) {
    const key = `parent-summary:${parent.delegationId}`;
    if (outboxKeyExists(db, key)) return;
    const subs = subIssues(parent.delegationId);
    const own = new Map(subs.map((sub) => [sub.issueId, sub]));
    const outside = new Map<string, SummaryIssue | null>();
    const lines: SummarySubIssue[] = [];
    for (const sub of subs) {
      const pending = pendingBlockers(parent, sub.issueId);
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
          external.push({ identifier: identifierFor(parent, blockerId), url: null });
      external.sort((left, right) => left.identifier.localeCompare(right.identifier));
      lines.push({
        identifier: sub.identifier,
        title: sub.title,
        url: sub.url,
        blockers: [...blockers, ...external],
      });
    }
    if (!lines.length) return;
    immediate(db, () => {
      if (readParent(parent.delegationId)?.stoppedAt !== null) return;
      enqueueOutboxOnce(db, {
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
  async function advance(parent: Parent, context: { signal: AbortSignal; isCurrent(): boolean }) {
    const startSession = input.startSession;
    if (!startSession) return;
    if (!ownerCanAct(parent))
      throw new Error("The person who delegated the parent no longer has workspace access.");
    for (const sub of subIssues(parent.delegationId)) {
      context.signal.throwIfAborted();
      if (sub.sessionId) {
        if (!sub.delegationId) await input.resumeSession(sub.sessionId);
        continue;
      }
      if (waitingFor(parent, sub.issueId).length > 0) continue;
      await startSession(
        { kind: "issue", id: sub.issueId },
        dashboardUrl(input.origin),
        context.signal,
        (event) => {
          if (!context.isCurrent()) throw new Error("The parent delegation claim changed.");
          if (event.issueId !== sub.issueId || !event.sessionId)
            throw new Error("Linear returned another sub-issue.");
          const changed = claimParentSubIssueSession(
            db,
            parent.delegationId,
            sub.issueId,
            event.sessionId,
          );
          if (changed !== 1) throw new Error("This sub-issue already has a session.");
        },
      );
    }
    await summarize(readParent(parent.delegationId)!, context.signal);
  }

  return {
    /**
     * Record a delegated parent so each sub-issue runs in its own session. Returns false when
     * the parent should run its sub-issues in its own session instead.
     */
    adoptParent(sessionId: string, snapshot: EpicSnapshot, edges: readonly DependencyEdge[]) {
      if (!input.startSession) return false;
      const session = getLinearSession(db, sessionId);
      if (!session?.organizationId || !session.creatorId) return false;
      const workspace = workspaceForOrganization(db, session.organizationId);
      if (!workspace) return false;
      if (parentDelegationActive(db, workspace.id, snapshot.linearIssueId)) return true;
      const owner = workspaceLinearMember(db, workspace.id, session.creatorId);
      if (!workspaceMemberUsable(owner)) return false;
      const issueIds = snapshot.subIssues.map((issue) => issue.linearIssueId);
      if (
        issueIds.some(
          (issueId) =>
            parentSubIssueActive(db, workspace.id, issueId) ||
            workspaceIssueHasOpenItem(db, workspace.id, issueId),
        )
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
      insertParentDelegation(db, {
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
      ordered.ordered.forEach((node, position) => {
        const issue = issues.get(node.linearIssueId)!;
        insertParentSubIssue(db, {
          parentDelegationId: delegationId,
          workspaceId: workspace.id,
          issueId: issue.linearIssueId,
          identifier: issue.identifier,
          title: issue.title,
          url: issue.url ?? null,
          position,
        });
      });
      saveTaskBlocks(
        db,
        issueIds,
        edges.filter((edge) => subIds.has(edge.blockedLinearIssueId)),
      );
      auditWorkspaceAccess(db, {
        workspaceId: workspace.id,
        userId: owner.userId,
        action: "parent.delegated",
        subject: `${delegationId}:${snapshot.linearIssueId}`,
        now: createdAt,
      });
      return true;
    },
    /** The sub-issues of a delegated parent, in blocks order, and what each waits for. */
    progress(parentDelegationId: string): ParentSubIssueProgress[] {
      const parent = readParent(parentDelegationId);
      if (!parent) return [];
      return subIssues(parentDelegationId).map((sub) => ({
        ...sub,
        waitingFor: sub.sessionId ? [] : waitingFor(parent, sub.issueId),
      }));
    },
    scope,
    authorizeIntake(sessionId: string, snapshot: EpicSnapshot): boolean {
      try {
        scope(sessionId, snapshot);
        return true;
      } catch (caughtError1) {
        journalCaught(caughtError1, "parent-delegation.authorizeIntake.scope", null);
        return false;
      }
    },
    /** A sub-issue's session acts for the person who delegated its parent. */
    actor(sessionId: string): string | undefined {
      const sub = subIssueForSession(sessionId);
      const parent = sub ? readParent(sub.parentDelegationId) : null;
      return parent ? ownerLinearUserId(parent) : undefined;
    },
    accepted(sessionId: string, result: IntakeResult): void {
      const sub = subIssueForSession(sessionId);
      if (!sub) return;
      const parent = readParent(sub.parentDelegationId)!;
      if (!result.ok || result.items.length !== 1 || result.items[0]?.linearIssueId !== sub.issueId)
        throw new Error("Intake did not keep the sub-issue to itself.");
      setItemOwner(db, result.items[0].id, parent.ownerUserId);
      setParentSubIssueDelegation(db, sessionId, result.delegation.id);
    },
    async authorizeEvent(event: AcceptedLinearEvent): Promise<IntakeDecision | undefined> {
      const sub = eventSubIssue(event);
      if (!sub) return undefined;
      const parent = readParent(sub.parentDelegationId)!;
      if (sub.sessionId === event.sessionId) return ACCEPTED;
      if (event.action !== "created" || parent.stoppedAt !== null) return refuse(parent, event);
      if (sub.sessionId === null)
        return refuse(
          parent,
          event,
          `${sub.identifier} waits for its blockers under its delegated parent. Paws opens its session when they finish.`,
        );
      if (!restartable(parent, sub))
        return refuse(
          parent,
          event,
          `${sub.identifier} is still running in its earlier Paws session. Paws continues there, so reply in that session to steer it.`,
        );
      const moved = immediate(db, () => {
        if (!restartable(parent, sub)) return false;
        for (const itemId of listFailedDelegationItemIds(db, sub.delegationId!))
          applyWorkItemEvent(db, itemId, "cancel");
        moveParentSubIssueSession(db, {
          parentDelegationId: sub.parentDelegationId,
          issueId: sub.issueId,
          from: sub.sessionId!,
          to: event.sessionId!,
        });
        return true;
      });
      return moved ? ACCEPTED : refuse(parent, event);
    },
    recheckEvent(event: AcceptedLinearEvent): boolean | undefined {
      const sub = eventSubIssue(event);
      if (!sub) return undefined;
      if (sub.sessionId === event.sessionId) return true;
      refuse(readParent(sub.parentDelegationId)!, event);
      return false;
    },
    async scopeSnapshot(sessionId: string, snapshot: EpicSnapshot) {
      return scope(sessionId, snapshot);
    },
    register(jobs: JobLoop) {
      if (!input.startSession) return;
      enqueueJobOnce(db, { queue: QUEUE, jobKey: QUEUE, recurringEveryMs: 30_000, now: now() });
      jobs.register(QUEUE, async (_job, context) => {
        for (const id of listActiveParentDelegationIds(db)) {
          context.signal.throwIfAborted();
          try {
            await advance(readParent(id)!, context);
            setParentDelegationError(db, id, null);
          } catch (caughtError2) {
            journalCaught(caughtError2, "parent-delegation.register.advance", null);
            context.signal.throwIfAborted();
            setParentDelegationError(
              db,
              id,
              "Sub-issue sessions could not be opened. Check Linear access.",
            );
          }
        }
      });
    },
  };
}
