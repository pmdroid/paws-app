import type { Database } from "bun:sqlite";
import {
  advanceLinearSessionGeneration,
  ensureLinearSession,
  getLinearSession,
  getLinearSessionAccess,
  getLinearSessionGeneration,
  getLinearSessionInstallation,
  getLinearTaskDelegation,
  getLinearTeamAccess,
  delegatedLinearUserId,
  getWorkItem,
  workItemForSession,
  listWorkItems,
  recordLinearInstallation,
  requireLinearTaskDelegation,
  type WorkItemRecord,
} from "../db";
import { sleep } from "../core";
import {
  LinearIssueClosedError,
  LinearRateLimitError,
  parseLinearSessionInstallation,
  type AcceptedLinearEvent,
  type LinearAccessReads,
  type LinearIssueLifecycle,
  type LinearIssueOwnership,
  type LinearSessionInstallation,
  type TrackerRequestOptions,
} from "../linear";

export class LinearAccessRemovedError extends Error {}

export const TASK_ACCESS_TTL_MS = 5 * 60_000;

type AccessVerdict = {
  sessionId: string;
  access: LinearSessionInstallation;
  issues: LinearIssueOwnership[];
  expiresAt: number;
};

export class LinearTaskAccess {
  private readonly verdicts = new Map<string, AccessVerdict>();

  constructor(
    private readonly db: Database,
    private readonly options: {
      access: LinearAccessReads | null;
      lifecycle: LinearIssueLifecycle | null;
      oauthClientId: string | null;
      appUserId: string | null;
      stopSession: (sessionId: string) => void;
      interruptSession?: (sessionId: string) => Promise<void>;
      now?: () => number;
    },
  ) {}

  async assertOpenIssue(event: AcceptedLinearEvent): Promise<void> {
    if (
      this.options.lifecycle === null ||
      event.issueId === null ||
      event.signal === "stop" ||
      !["created", "prompted"].includes(event.action)
    )
      return;
    const issue = await this.options.lifecycle.inspect(event.issueId, {
      signal: AbortSignal.timeout(10_000),
    });
    if (["completed", "canceled", "duplicate"].includes(issue.stateType))
      throw new LinearIssueClosedError(issue.identifier ?? "This issue");
  }

  async accept(event: AcceptedLinearEvent, options?: TrackerRequestOptions): Promise<boolean> {
    if (event.sessionId === null || !["created", "prompted"].includes(event.action)) return false;
    const generation = getLinearSessionGeneration(this.db, event.sessionId);
    if (getLinearSessionAccess(this.db, event.sessionId) === "revoked") return false;
    if (event.action === "created" && getLinearSession(this.db, event.sessionId)?.stoppedAt != null)
      return false;
    const installation = parseLinearSessionInstallation(event);
    if (event.source === "webhook" && installation === null) return false;
    if (installation !== null) {
      if (
        installation.oauthClientId !== this.options.oauthClientId ||
        (this.options.appUserId !== null && installation.appUserId !== this.options.appUserId)
      )
        return false;
      recordLinearInstallation(this.db, { ...installation, observedAtMs: event.updatedAtMs });
    }
    if (event.signal === "stop")
      return (
        getLinearSessionInstallation(this.db, event.sessionId) !== null &&
        getLinearSessionAccess(this.db, event.sessionId) !== "revoked"
      );
    if (this.options.access === null) throw new Error("Linear is not connected.");
    const request = { ...options, signal: options?.signal ?? AbortSignal.timeout(10_000) };
    request.signal.throwIfAborted();
    const access = await this.options.access.session(event.sessionId, request);
    request.signal.throwIfAborted();
    this.record(access);
    if (getLinearSessionGeneration(this.db, event.sessionId) !== generation) return false;
    if (event.action === "created" && getLinearSession(this.db, event.sessionId)?.stoppedAt != null)
      return false;
    if (access.issueId !== event.issueId)
      throw new Error("Linear session issue ownership changed.");
    if (!(await this.teamAccess(access, generation, request))) return false;
    return this.allowed(event.sessionId);
  }

  invalidate(scope: { sessionId?: string; issueId?: string } = {}): void {
    for (const [key, verdict] of this.verdicts)
      if (
        (scope.sessionId === undefined || verdict.sessionId === scope.sessionId) &&
        (scope.issueId === undefined || verdict.issues.some((issue) => issue.id === scope.issueId))
      )
        this.verdicts.delete(key);
  }

  async reconcile(issueId: string): Promise<void> {
    this.invalidate({ issueId });
    await this.reconcileItems(
      (item, sessionId) =>
        item.linearIssueId === issueId || getLinearSession(this.db, sessionId)?.issueId === issueId,
    );
  }

  async revalidateSessions(sessionIds: readonly string[]): Promise<void> {
    const affected = new Set(sessionIds);
    for (const sessionId of affected) this.invalidate({ sessionId });
    const active = new Set(
      listWorkItems(this.db)
        .filter(
          (item) =>
            !["cancelled", "completed", "merged", "failed", "exhausted"].includes(item.state),
        )
        .flatMap((item) => (item.sessionKey === null ? [] : [item.sessionKey])),
    );
    await this.reconcileItems((_item, sessionId) => affected.has(sessionId));
    for (const sessionId of affected) {
      if (active.has(sessionId)) continue;
      const session = getLinearSession(this.db, sessionId);
      if (session === null || session.stoppedAt !== null) continue;
      if (this.options.access === null) throw new Error("Linear is not connected.");
      const access = await this.options.access.session(sessionId, {
        signal: AbortSignal.timeout(10_000),
      });
      if (getLinearSessionGeneration(this.db, sessionId) !== session.generation) continue;
      this.record(access);
      await this.teamAccess(access, session.generation);
    }
  }

  private async teamAccess(
    access: LinearSessionInstallation,
    generation: number,
    options?: TrackerRequestOptions,
  ): Promise<boolean> {
    if (this.options.access === null) throw new Error("Linear is not connected.");
    const request = { ...options, signal: options?.signal ?? AbortSignal.timeout(10_000) };
    request.signal.throwIfAborted();
    const allowed = await this.options.access.team(access.teamId, request);
    request.signal.throwIfAborted();
    if (getLinearSessionGeneration(this.db, access.sessionId) !== generation) return false;
    if (!this.allowed(access.sessionId)) return false;
    if (allowed) return true;
    advanceLinearSessionGeneration(this.db, access.sessionId, {
      stop: true,
      now: (this.options.now ?? Date.now)(),
    });
    this.options.stopSession(access.sessionId);
    await this.options.interruptSession?.(access.sessionId);
    return false;
  }

  private async reconcileItems(
    accept: (item: WorkItemRecord, sessionId: string) => boolean,
  ): Promise<void> {
    for (const item of listWorkItems(this.db)) {
      if (["cancelled", "completed", "merged", "failed", "exhausted"].includes(item.state))
        continue;
      const sessionId = item.sessionKey;
      if (sessionId === null || !accept(item, sessionId)) continue;
      try {
        await this.assert(item, AbortSignal.timeout(10_000), { fresh: true });
      } catch (error) {
        if (
          error instanceof LinearAccessRemovedError ||
          getWorkItem(this.db, item.id)?.state === "cancelled"
        )
          continue;
        throw error;
      }
    }
  }

  async prepare(item: WorkItemRecord, signal: AbortSignal): Promise<readonly string[]> {
    if (item.sessionKey !== null) this.invalidate({ sessionId: item.sessionKey });
    return outlastRateLimits(signal, () => this.check(item, signal, true));
  }

  async assert(
    item: WorkItemRecord,
    signal: AbortSignal,
    options: { allowTerminalIssue?: boolean; fresh?: boolean } = {},
  ): Promise<void> {
    await outlastRateLimits(signal, () =>
      this.check(item, signal, false, options.allowTerminalIssue ?? false, options.fresh ?? false),
    );
  }

  async assertDelivery(
    sessionId: string,
    signal: AbortSignal,
    options: { itemId?: string; issueId?: string; stop?: boolean; isCurrent(): boolean },
  ): Promise<void> {
    if (this.options.access === null || this.options.lifecycle === null)
      throw new Error("Linear is not connected.");
    const generation = getLinearSessionGeneration(this.db, sessionId);
    const current = () => {
      signal.throwIfAborted();
      if (
        !options.isCurrent() ||
        getLinearSessionGeneration(this.db, sessionId) !== generation ||
        getLinearSessionAccess(this.db, sessionId) !== "allowed"
      )
        throw new LinearAccessRemovedError("Linear delivery access was stopped or superseded.");
    };
    current();
    if (options.stop) return;
    const access = await this.options.access.session(sessionId, { signal });
    current();
    this.record(access);
    current();
    const itemId = options.itemId ?? workItemForSession(this.db, sessionId)?.id;
    const item = itemId ? getWorkItem(this.db, itemId) : null;
    if (item && item.sessionKey !== sessionId)
      throw new Error("Linear delivery belongs to another session.");
    const issueIds = [access.issueId];
    if (options.issueId) issueIds.push(options.issueId);
    if (item) issueIds.push(item.linearIssueId);
    for (const issueId of new Set(issueIds)) {
      const issue = await this.options.lifecycle.inspect(issueId, { signal });
      current();
      if (
        issue.id !== issueId ||
        getLinearTeamAccess(this.db, { ...access, teamId: issue.teamId }) === "removed" ||
        !(await this.options.access.team(issue.teamId, { signal }))
      )
        throw new LinearAccessRemovedError("Linear delivery team access was removed.");
      current();
      const required = item ? getLinearTaskDelegation(this.db, item.id, issue.id) : null;
      if (
        (issue.delegateId !== null && issue.delegateId !== access.appUserId) ||
        (required !== null && issue.delegateId !== required.appUserId)
      )
        throw new LinearAccessRemovedError("Linear delivery delegation access was removed.");
    }
    current();
  }

  private async check(
    item: WorkItemRecord,
    signal: AbortSignal,
    prepare: boolean,
    allowTerminalIssue = false,
    fresh = false,
  ): Promise<readonly string[]> {
    if (this.options.access === null || this.options.lifecycle === null)
      throw new Error("Linear is not connected.");
    const sessionId = item.sessionKey;
    if (sessionId === null) throw new Error("Linear task has no verified session.");
    const generation = getLinearSessionGeneration(this.db, sessionId);
    const current = (allowUnknown = false) => {
      signal.throwIfAborted();
      const stored = getWorkItem(this.db, item.id);
      const session = getLinearSession(this.db, sessionId);
      if (
        stored === null ||
        stored.cancelRequested ||
        ["cancelled", "completed", "merged"].includes(stored.state) ||
        session?.stoppedAt != null ||
        getLinearSessionGeneration(this.db, sessionId) !== generation
      )
        throw new Error("Linear task was stopped or superseded.");
      if (allowUnknown && getLinearSessionAccess(this.db, sessionId) === "unknown") return;
      if (!this.allowed(sessionId))
        throw new LinearAccessRemovedError("Linear installation access is unavailable.");
    };
    current(true);
    const key = JSON.stringify([item.id, sessionId, generation, item.linearIssueId]);
    const cached = this.verdicts.get(key);
    const now = (this.options.now ?? Date.now)();
    if (!prepare && !fresh && cached !== undefined && cached.expiresAt > now) {
      current();
      if (
        cached.issues.every((issue) => this.permits(item, cached.access, issue, allowTerminalIssue))
      )
        return [];
    }
    this.verdicts.delete(key);
    const access = await this.options.access.session(sessionId, { signal });
    current(true);
    this.record(access);
    current();
    const issues: LinearIssueOwnership[] = [];
    for (const issueId of new Set([access.issueId, item.linearIssueId])) {
      const issue = await this.options.lifecycle.inspect(issueId, { signal });
      current();
      if (issue.id !== issueId) throw new Error("Linear returned another task issue.");
      this.ownership(item, sessionId, access, issue, allowTerminalIssue);
      if (!(await this.options.access.team(issue.teamId, { signal }))) {
        this.invalidate({ sessionId });
        this.options.stopSession(sessionId);
        throw new LinearAccessRemovedError("Linear task team access was removed.");
      }
      current();
      issues.push(issue);
    }
    const eligible: string[] = [];
    if (!prepare) {
      this.verdicts.set(key, {
        sessionId,
        access,
        issues,
        expiresAt: (this.options.now ?? Date.now)() + TASK_ACCESS_TTL_MS,
      });
      return eligible;
    }
    for (const issue of issues.reverse()) {
      current();
      const actorId = delegatedLinearUserId(this.db, item.id);
      const result = await this.options.lifecycle.startCodeIssue(
        { issueId: issue.id, appUserId: access.appUserId, actorId },
        {
          signal,
          beforeStart: (verifiedIssue) => {
            current();
            this.ownership(item, sessionId, access, verifiedIssue);
            requireLinearTaskDelegation(this.db, {
              itemId: item.id,
              issueId: verifiedIssue.id,
              teamId: verifiedIssue.teamId,
              appUserId: access.appUserId,
              humanActorId: actorId,
            });
          },
        },
      );
      current();
      this.ownership(item, sessionId, access, result.issue);
      if (result.eligible) eligible.push(issue.id);
    }
    return eligible;
  }

  private ownership(
    item: WorkItemRecord,
    sessionId: string,
    access: LinearSessionInstallation,
    issue: LinearIssueOwnership,
    allowTerminalIssue = false,
  ): void {
    if (!this.permits(item, access, issue, allowTerminalIssue)) {
      this.invalidate({ sessionId });
      this.options.stopSession(sessionId);
      throw new LinearAccessRemovedError("Linear task delegation or workflow access was removed.");
    }
    if (issue.delegateId === access.appUserId)
      requireLinearTaskDelegation(this.db, {
        itemId: item.id,
        issueId: issue.id,
        teamId: issue.teamId,
        appUserId: access.appUserId,
      });
  }

  private permits(
    item: WorkItemRecord,
    access: LinearSessionInstallation,
    issue: LinearIssueOwnership,
    allowTerminalIssue: boolean,
  ): boolean {
    const required = getLinearTaskDelegation(this.db, item.id, issue.id);
    return !(
      getLinearTeamAccess(this.db, { ...access, teamId: issue.teamId }) === "removed" ||
      (!allowTerminalIssue && ["completed", "canceled", "duplicate"].includes(issue.stateType)) ||
      (issue.delegateId !== null && issue.delegateId !== access.appUserId) ||
      (required !== null &&
        (required.appUserId !== access.appUserId || issue.delegateId !== access.appUserId))
    );
  }

  private allowed(sessionId: string): boolean {
    if (getLinearSessionAccess(this.db, sessionId) === "allowed") return true;
    this.options.stopSession(sessionId);
    return false;
  }

  private record(access: LinearSessionInstallation): void {
    if (
      access.oauthClientId !== this.options.oauthClientId ||
      (this.options.appUserId !== null && access.appUserId !== this.options.appUserId)
    )
      throw new Error("The Linear credential belongs to another installation.");
    ensureLinearSession(this.db, { sessionId: access.sessionId, issueId: access.issueId });
    recordLinearInstallation(this.db, {
      ...access,
      observedAtMs: (this.options.now ?? Date.now)(),
    });
  }
}

export async function authorizeLinearTask(
  access: LinearTaskAccess,
  item: WorkItemRecord,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    await access.assert(item, signal);
    return true;
  } catch (error) {
    if (error instanceof LinearAccessRemovedError) return false;
    throw error;
  }
}

const RATE_LIMIT_WAIT_MS = 15 * 60_000;

async function outlastRateLimits<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + RATE_LIMIT_WAIT_MS;
  for (;;) {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof LinearRateLimitError) || Date.now() >= deadline) throw error;
      await sleep(Math.min(Math.max(error.retryAfterMs, 1_000), 60_000), signal);
      signal.throwIfAborted();
    }
  }
}
