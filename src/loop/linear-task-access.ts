import { journalCaught } from "../journal";
import {
  advanceLinearSessionGeneration,
  ensureLinearSessionSteps,
  getLinearSessionAccessSteps,
  getLinearSessionGenerationSteps,
  getLinearSessionInstallationSteps,
  getLinearSessionSteps,
  getLinearTaskDelegationSteps,
  getLinearTeamAccessSteps,
  delegatedLinearUserIdSteps,
  getWorkItemSteps,
  workItemForSessionSteps,
  listWorkItemsSteps,
  recordLinearInstallationSteps,
  requireLinearTaskDelegationSteps,
  type Db,
  type Q,
  type Steps,
  type WorkItemRecord,
} from "../db";
import { isTerminalWorkItemState, sleep } from "../core";
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
import { linearSessionCreatorId } from "./linear-routing";

export class LinearAccessRemovedError extends Error {}

type AccessVerdict = {
  sessionId: string;
  access: LinearSessionInstallation;
  issues: LinearIssueOwnership[];
};

function verdictKey(item: WorkItemRecord, sessionId: string, generation: number): string {
  return JSON.stringify([item.id, sessionId, generation, item.linearIssueId]);
}

function* permitsSteps(
  q: Q,
  item: WorkItemRecord,
  access: LinearSessionInstallation,
  issue: LinearIssueOwnership,
  allowTerminalIssue: boolean,
): Steps<boolean> {
  const required = yield* getLinearTaskDelegationSteps(q, item.id, issue.id);
  return !(
    (yield* getLinearTeamAccessSteps(q, { ...access, teamId: issue.teamId })) === "removed" ||
    (!allowTerminalIssue && ["completed", "canceled", "duplicate"].includes(issue.stateType)) ||
    (issue.delegateId !== null && issue.delegateId !== access.appUserId) ||
    (required !== null &&
      (required.appUserId !== access.appUserId || issue.delegateId !== access.appUserId))
  );
}

export class LinearTaskAccess {
  private readonly verdicts = new Map<string, AccessVerdict>();
  private readonly teams = new Set<string>();
  private readonly issues = new Map<string, LinearIssueOwnership>();
  private invalidations = 0;
  private readonly store: Db;

  constructor(
    store: Db,
    private readonly options: {
      access: LinearAccessReads | null;
      lifecycle: LinearIssueLifecycle | null;
      oauthClientId: string | null;
      appUserId: string | null;
      stopSession: (q: Q, sessionId: string) => Steps<void>;
      interruptSession?: (sessionId: string) => Promise<void>;
      now?: () => number;
    },
  ) {
    this.store = store;
  }

  private session(sessionId: string) {
    return this.store.run((q) => getLinearSessionSteps(q, sessionId));
  }

  private sessionAccess(sessionId: string) {
    return this.store.run((q) => getLinearSessionAccessSteps(q, sessionId));
  }

  private sessionGeneration(sessionId: string) {
    return this.store.run((q) => getLinearSessionGenerationSteps(q, sessionId));
  }

  private teamStatus(input: LinearSessionInstallation & { teamId: string }) {
    return this.store.run((q) => getLinearTeamAccessSteps(q, input));
  }

  async assertOpenIssue(event: AcceptedLinearEvent): Promise<void> {
    if (
      this.options.lifecycle === null ||
      event.issueId === null ||
      event.signal === "stop" ||
      !["created", "prompted"].includes(event.action)
    )
      return;
    const signal = AbortSignal.timeout(10_000);
    const issue =
      event.action === "created"
        ? await this.inspect(event.issueId, { signal }, false, linearSessionCreatorId(event))
        : await this.inspect(event.issueId, { signal });
    if (["completed", "canceled", "duplicate"].includes(issue.stateType))
      throw new LinearIssueClosedError(issue.identifier ?? "This issue");
  }

  async accept(event: AcceptedLinearEvent, options?: TrackerRequestOptions): Promise<boolean> {
    const { sessionId } = event;
    if (sessionId === null || !["created", "prompted"].includes(event.action)) return false;
    const generation = await this.sessionGeneration(sessionId);
    if ((await this.sessionAccess(sessionId)) === "revoked") return false;
    if (event.action === "created" && (await this.session(sessionId))?.stoppedAt != null)
      return false;
    const installation = parseLinearSessionInstallation(event);
    if (event.source === "webhook" && installation === null) return false;
    if (installation !== null) {
      if (
        installation.oauthClientId !== this.options.oauthClientId ||
        (this.options.appUserId !== null && installation.appUserId !== this.options.appUserId)
      )
        return false;
      await this.store.transaction((q) =>
        recordLinearInstallationSteps(q, { ...installation, observedAtMs: event.updatedAtMs }),
      );
    }
    if (event.signal === "stop")
      return (
        (await this.store.run((q) => getLinearSessionInstallationSteps(q, sessionId))) !== null &&
        (await this.sessionAccess(sessionId)) !== "revoked"
      );
    if (this.options.access === null) throw new Error("Linear is not connected.");
    const request = { ...options, signal: options?.signal ?? AbortSignal.timeout(10_000) };
    request.signal.throwIfAborted();
    const access =
      installation?.teamId && event.issueId
        ? { ...installation, issueId: event.issueId, teamId: installation.teamId }
        : await this.options.access.session(sessionId, request);
    request.signal.throwIfAborted();
    await this.record(access);
    await this.store.transaction((q) =>
      ensureLinearSessionSteps(q, { sessionId, creatorId: linearSessionCreatorId(event) }),
    );
    if ((await this.sessionGeneration(sessionId)) !== generation) return false;
    if (event.action === "created" && (await this.session(sessionId))?.stoppedAt != null)
      return false;
    if (access.issueId !== event.issueId)
      throw new Error("Linear session issue ownership changed.");
    if (installation?.teamId) this.teams.add(access.teamId);
    if (!(await this.teamAccess(access, generation, request))) return false;
    return this.allowed(sessionId);
  }

  invalidate(scope: { sessionId?: string; issueId?: string } = {}): void {
    this.invalidations += 1;
    if (scope.issueId === undefined) this.teams.clear();
    if (scope.issueId !== undefined) this.issues.delete(scope.issueId);
    else if (scope.sessionId === undefined) this.issues.clear();
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
      async (item, sessionId) =>
        item.linearIssueId === issueId || (await this.session(sessionId))?.issueId === issueId,
    );
  }

  async revalidateSessions(sessionIds: readonly string[]): Promise<void> {
    const affected = new Set(sessionIds);
    for (const sessionId of affected) this.invalidate({ sessionId });
    const active = new Set(
      (await this.store.run(listWorkItemsSteps))
        .filter((item) => !["cancelled", "completed", "merged", "failed"].includes(item.state))
        .flatMap((item) => (item.sessionKey === null ? [] : [item.sessionKey])),
    );
    await this.reconcileItems(async (_item, sessionId) => affected.has(sessionId));
    for (const sessionId of affected) {
      if (active.has(sessionId)) continue;
      const session = await this.session(sessionId);
      if (session === null || session.stoppedAt !== null) continue;
      if (this.options.access === null) throw new Error("Linear is not connected.");
      const access = await this.options.access.session(sessionId, {
        signal: AbortSignal.timeout(10_000),
      });
      if ((await this.sessionGeneration(sessionId)) !== session.generation) continue;
      await this.record(access);
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
    const allowed =
      (await this.teamStatus(access)) !== "removed" && (await this.team(access.teamId, request));
    request.signal.throwIfAborted();
    if ((await this.sessionGeneration(access.sessionId)) !== generation) return false;
    if (allowed) return this.allowed(access.sessionId);
    await advanceLinearSessionGeneration(this.store, access.sessionId, {
      stop: true,
      now: (this.options.now ?? Date.now)(),
    });
    await this.store.run((q) => this.options.stopSession(q, access.sessionId));
    await this.options.interruptSession?.(access.sessionId);
    return false;
  }

  private async reconcileItems(
    accept: (item: WorkItemRecord, sessionId: string) => Promise<boolean>,
  ): Promise<void> {
    for (const item of await this.store.run(listWorkItemsSteps)) {
      if (["cancelled", "completed", "merged", "failed"].includes(item.state)) continue;
      const sessionId = item.sessionKey;
      if (sessionId === null || !(await accept(item, sessionId))) continue;
      try {
        await this.assert(item, AbortSignal.timeout(10_000), { fresh: true });
      } catch (error) {
        if (
          error instanceof LinearAccessRemovedError ||
          (await this.store.run((q) => getWorkItemSteps(q, item.id)))?.state === "cancelled"
        ) {
          journalCaught(
            error,
            "linear-task-access.reconcileItems.assert",
            item.id,
            "work-item access removed or item cancelled",
          );
          continue;
        }
        throw error;
      }
    }
  }

  async prepare(item: WorkItemRecord, signal: AbortSignal): Promise<readonly string[]> {
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
    options: {
      itemId?: string;
      issueId?: string;
      stop?: boolean;
      fresh?: boolean;
      isCurrent(): Promise<boolean>;
    },
  ): Promise<void> {
    if (this.options.access === null || this.options.lifecycle === null)
      throw new Error("Linear is not connected.");
    const generation = await this.sessionGeneration(sessionId);
    const current = async () => {
      signal.throwIfAborted();
      if (
        !(await options.isCurrent()) ||
        (await this.sessionGeneration(sessionId)) !== generation ||
        (await this.sessionAccess(sessionId)) !== "allowed"
      )
        throw new LinearAccessRemovedError("Linear delivery access was stopped or superseded.");
    };
    await current();
    if (options.stop) return;
    const itemId =
      options.itemId ?? (await this.store.run((q) => workItemForSessionSteps(q, sessionId)))?.id;
    const item = itemId ? await this.store.run((q) => getWorkItemSteps(q, itemId)) : null;
    if (item && item.sessionKey !== sessionId)
      throw new Error("Linear delivery belongs to another session.");
    const verdict = item ? this.verdicts.get(verdictKey(item, sessionId, generation)) : undefined;
    if (
      item &&
      verdict &&
      (!options.issueId || verdict.issues.some((issue) => issue.id === options.issueId)) &&
      (await this.permitsAll(item, verdict.access, verdict.issues, true))
    )
      return;
    const stored = options.fresh ? null : await this.stored(sessionId);
    const access = stored ?? (await this.options.access.session(sessionId, { signal }));
    await current();
    if (stored === null) await this.record(access);
    await current();
    const issueIds = [access.issueId];
    if (options.issueId) issueIds.push(options.issueId);
    if (item) issueIds.push(item.linearIssueId);
    for (const issueId of new Set(issueIds)) {
      const issue = await this.inspect(
        issueId,
        { signal },
        options.fresh,
        item ? undefined : ((await this.session(sessionId))?.creatorId ?? null),
      );
      await current();
      if (
        issue.id !== issueId ||
        (await this.teamStatus({ ...access, teamId: issue.teamId })) === "removed" ||
        !(await this.team(issue.teamId, { signal }, options.fresh))
      )
        throw new LinearAccessRemovedError("Linear delivery team access was removed.");
      await current();
      const required = item
        ? await this.store.run((q) => getLinearTaskDelegationSteps(q, item.id, issue.id))
        : null;
      if (
        (issue.delegateId !== null && issue.delegateId !== access.appUserId) ||
        (required !== null && issue.delegateId !== required.appUserId)
      )
        throw new LinearAccessRemovedError("Linear delivery delegation access was removed.");
    }
    await current();
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
    const generation = await this.sessionGeneration(sessionId);
    const currentSteps = (q: Q, allowUnknown = false) =>
      this.currentSteps(q, { itemId: item.id, sessionId, generation, signal }, allowUnknown);
    const current = (allowUnknown = false) => this.store.run((q) => currentSteps(q, allowUnknown));
    await current(true);
    const key = verdictKey(item, sessionId, generation);
    const cached = fresh ? undefined : this.verdicts.get(key);
    if (cached !== undefined) await current();
    const invalidations = this.invalidations;
    const verdict =
      cached !== undefined &&
      (await this.permitsAll(item, cached.access, cached.issues, allowTerminalIssue))
        ? cached
        : await this.read(item, sessionId, signal, allowTerminalIssue, fresh, current);
    if (this.invalidations === invalidations) this.verdicts.set(key, verdict);
    if (!prepare) return [];
    const { access } = verdict;
    const started = new Map<string, LinearIssueOwnership>();
    const eligible: string[] = [];
    for (const issue of [...verdict.issues].reverse()) {
      await current();
      const actorId = await this.store.run((q) => delegatedLinearUserIdSteps(q, item.id));
      const result = await this.options.lifecycle.startCodeIssue(
        { issueId: issue.id, appUserId: access.appUserId, actorId },
        {
          signal,
          issue,
          beforeStart: (verifiedIssue) =>
            this.store.run((q) =>
              this.beforeStartSteps(q, currentSteps, {
                item,
                sessionId,
                access,
                issue: verifiedIssue,
                actorId,
              }),
            ),
        },
      );
      await current();
      await this.store.run((q) => this.ownershipSteps(q, item, sessionId, access, result.issue));
      if (this.invalidations === invalidations) this.issues.set(issue.id, result.issue);
      started.set(issue.id, result.issue);
      if (result.eligible) eligible.push(issue.id);
    }
    if (this.invalidations === invalidations)
      this.verdicts.set(key, {
        ...verdict,
        issues: verdict.issues.map((issue) => started.get(issue.id) ?? issue),
      });
    return eligible;
  }

  private *currentSteps(
    q: Q,
    task: { itemId: string; sessionId: string; generation: number; signal: AbortSignal },
    allowUnknown: boolean,
  ): Steps<void> {
    const { itemId, sessionId, generation, signal } = task;
    signal.throwIfAborted();
    const stored = yield* getWorkItemSteps(q, itemId);
    const session = yield* getLinearSessionSteps(q, sessionId);
    if (
      stored === null ||
      stored.cancelRequested ||
      isTerminalWorkItemState(stored.state) ||
      session?.stoppedAt != null ||
      (yield* getLinearSessionGenerationSteps(q, sessionId)) !== generation
    )
      throw new Error("Linear task was stopped or superseded.");
    if (allowUnknown && (yield* getLinearSessionAccessSteps(q, sessionId)) === "unknown") return;
    if (!(yield* this.allowedSteps(q, sessionId)))
      throw new LinearAccessRemovedError("Linear installation access is unavailable.");
  }

  private *beforeStartSteps(
    q: Q,
    currentSteps: (q: Q) => Steps<void>,
    start: {
      item: WorkItemRecord;
      sessionId: string;
      access: LinearSessionInstallation;
      issue: LinearIssueOwnership;
      actorId: string | null;
    },
  ): Steps<void> {
    const { item, sessionId, access, issue, actorId } = start;
    yield* currentSteps(q);
    yield* this.ownershipSteps(q, item, sessionId, access, issue);
    yield* requireLinearTaskDelegationSteps(q, {
      itemId: item.id,
      issueId: issue.id,
      teamId: issue.teamId,
      appUserId: access.appUserId,
      humanActorId: actorId,
    });
  }

  private async read(
    item: WorkItemRecord,
    sessionId: string,
    signal: AbortSignal,
    allowTerminalIssue: boolean,
    fresh: boolean,
    current: (allowUnknown?: boolean) => Promise<void>,
  ): Promise<AccessVerdict> {
    if (this.options.access === null || this.options.lifecycle === null)
      throw new Error("Linear is not connected.");
    const stored = fresh ? null : await this.stored(sessionId);
    const access = stored ?? (await this.options.access.session(sessionId, { signal }));
    await current(true);
    if (stored === null) await this.record(access);
    await current();
    const issues: LinearIssueOwnership[] = [];
    for (const issueId of new Set([access.issueId, item.linearIssueId])) {
      const issue = await this.inspect(issueId, { signal }, fresh);
      await current();
      if (issue.id !== issueId) throw new Error("Linear returned another task issue.");
      await this.store.run((q) =>
        this.ownershipSteps(q, item, sessionId, access, issue, allowTerminalIssue),
      );
      if (!(await this.team(issue.teamId, { signal }, fresh))) {
        this.invalidate({ sessionId });
        await this.store.run((q) => this.options.stopSession(q, sessionId));
        throw new LinearAccessRemovedError("Linear task team access was removed.");
      }
      await current();
      issues.push(issue);
    }
    return { sessionId, access, issues };
  }

  private *ownershipSteps(
    q: Q,
    item: WorkItemRecord,
    sessionId: string,
    access: LinearSessionInstallation,
    issue: LinearIssueOwnership,
    allowTerminalIssue = false,
  ): Steps<void> {
    if (!(yield* permitsSteps(q, item, access, issue, allowTerminalIssue))) {
      this.invalidate({ sessionId });
      yield* this.options.stopSession(q, sessionId);
      throw new LinearAccessRemovedError("Linear task delegation or workflow access was removed.");
    }
    if (issue.delegateId === access.appUserId)
      yield* requireLinearTaskDelegationSteps(q, {
        itemId: item.id,
        issueId: issue.id,
        teamId: issue.teamId,
        appUserId: access.appUserId,
      });
  }

  private permitsAll(
    item: WorkItemRecord,
    access: LinearSessionInstallation,
    issues: readonly LinearIssueOwnership[],
    allowTerminalIssue: boolean,
  ): Promise<boolean> {
    return this.store.run(function* (q): Steps<boolean> {
      for (const issue of issues)
        if (!(yield* permitsSteps(q, item, access, issue, allowTerminalIssue))) return false;
      return true;
    });
  }

  private async stored(sessionId: string): Promise<LinearSessionInstallation | null> {
    const installation = await this.store.run((q) =>
      getLinearSessionInstallationSteps(q, sessionId),
    );
    const issueId = (await this.session(sessionId))?.issueId;
    if (!installation?.teamId || !issueId) return null;
    return {
      organizationId: installation.organizationId,
      oauthClientId: installation.oauthClientId,
      appUserId: installation.appUserId,
      sessionId,
      issueId,
      teamId: installation.teamId,
    };
  }

  private async inspect(
    issueId: string,
    options: TrackerRequestOptions,
    fresh = false,
    startedBy?: string | null,
  ): Promise<LinearIssueOwnership> {
    const lifecycle = this.options.lifecycle;
    if (lifecycle === null) throw new Error("Linear is not connected.");
    const cached = fresh ? undefined : this.issues.get(issueId);
    if (cached !== undefined) return { ...cached };
    const invalidations = this.invalidations;
    const issue =
      startedBy !== undefined && lifecycle.inspectStart
        ? await lifecycle.inspectStart(issueId, startedBy, options)
        : await lifecycle.inspect(issueId, options);
    if (this.invalidations === invalidations && issue.id === issueId)
      this.issues.set(issueId, issue);
    return issue;
  }

  private async team(teamId: string, options: TrackerRequestOptions, fresh = false) {
    if (this.options.access === null) throw new Error("Linear is not connected.");
    if (!fresh && this.teams.has(teamId)) return true;
    const invalidations = this.invalidations;
    const allowed = await this.options.access.team(teamId, options);
    if (allowed && this.invalidations === invalidations) this.teams.add(teamId);
    if (!allowed) this.teams.delete(teamId);
    return allowed;
  }

  private allowed(sessionId: string): Promise<boolean> {
    return this.store.run((q) => this.allowedSteps(q, sessionId));
  }

  private *allowedSteps(q: Q, sessionId: string): Steps<boolean> {
    if ((yield* getLinearSessionAccessSteps(q, sessionId)) === "allowed") return true;
    yield* this.options.stopSession(q, sessionId);
    return false;
  }

  private async record(access: LinearSessionInstallation): Promise<void> {
    if (
      access.oauthClientId !== this.options.oauthClientId ||
      (this.options.appUserId !== null && access.appUserId !== this.options.appUserId)
    )
      throw new Error("The Linear credential belongs to another installation.");
    await this.store.transaction((q) =>
      ensureLinearSessionSteps(q, { sessionId: access.sessionId, issueId: access.issueId }),
    );
    await this.store.transaction((q) =>
      recordLinearInstallationSteps(q, {
        ...access,
        observedAtMs: (this.options.now ?? Date.now)(),
      }),
    );
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
    if (error instanceof LinearAccessRemovedError) {
      journalCaught(error, "linear-task-access.authorizeLinearTask.assert", item?.id);
      return false;
    }
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
      journalCaught(error, "linear-task-access.outlastRateLimits.read", null);
      await sleep(Math.min(Math.max(error.retryAfterMs, 1_000), 60_000), signal);
      signal.throwIfAborted();
    }
  }
}
