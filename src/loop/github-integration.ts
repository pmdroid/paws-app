import { askSteps } from "./operations";
import { journalCaught } from "../journal";
import { isTransient, JOB_KIND, sleep } from "../core";
import { LinearRateLimitError } from "../linear";
import {
  applyWorkItemEventSteps,
  applyLinearCommandSteps,
  commandInstance,
  emitJobReady,
  enqueueJobOnceSteps,
  enqueueOutboxOnceSteps,
  getLinearSession,
  getLinearSessionGenerationSteps,
  getWorkItemSteps,
  githubIntegrationHoldStatus,
  githubIntegrationHoldStatusSteps,
  insertGithubIntegrationHoldSteps,
  pendingGithubIntegrationHoldsSteps,
  setGithubIntegrationHoldStatus,
  setGithubIntegrationHoldStatusSteps,
  setOpenQuestionBodySteps,
  syncSteps,
  type Db,
  type Q,
  type Steps,
  type WorkItemRecord,
} from "../db";
import {
  answerSteps,
  findOpenQuestionSteps,
  getQuestionSteps,
  type StoredQuestion,
} from "../questions";

export const TASK_ACCESS_TTL_MS = 5 * 60_000;

export type GitHubInstallationPhase = "initial" | "publication";

/**
 * A refusal that says why. The reason ends the Linear session in place of the default
 * "Cancelled from Linear." response.
 */
export type GitHubDenial = { denied: true; reason: string };

type Denied = { denied: true; reason: string | null };

/** The team has no repository Paws may use: no mapping and none in the catalog. */
export function noRepositoryDenial(team: string, administrators: readonly string[]): GitHubDenial {
  return {
    denied: true,
    reason: `${team} has no repository in Paws yet. Ask ${people(administrators)} to map one in Integrations, then delegate again.`,
  };
}

/** The team has repository mappings, and the item's repository is not one of them. */
export function unmappedRepositoryDenial(repository: string, team: string): GitHubDenial {
  return { denied: true, reason: `${repository} isn't mapped to ${team} in Paws.` };
}

/** The delegator is not in the issue's team in Paws. */
export function notTeamMemberDenial(team: string): GitHubDenial {
  return { denied: true, reason: `You're not a member of ${team} in Paws.` };
}

function people(names: readonly string[]): string {
  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  if (unique.length === 0) return "a Paws admin";
  if (unique.length === 1) return unique[0]!;
  return `${unique.slice(0, -1).join(", ")} or ${unique.at(-1)}`;
}

/** What the host knows about the workspace GitHub App installation for an item. */
export type GitHubIntegration = {
  check(item: WorkItemRecord, signal: AbortSignal): Promise<boolean>;
  /** False, or a `GitHubDenial` with its reason, cancels the item. */
  authorize?(item: WorkItemRecord, signal: AbortSignal): Promise<boolean | GitHubDenial>;
  administrators(q: Q, item: WorkItemRecord): Steps<readonly string[]>;
  recoveryUrl: string;
  identity(q: Q, item: WorkItemRecord): Steps<string>;
  /** False, or a `GitHubDenial` with its reason, cancels the item without a read. */
  current?(q: Q, item: WorkItemRecord): Steps<boolean | GitHubDenial>;
  unavailableRetryMs?: readonly number[];
};

type Hold = {
  question_id: string;
  item_id: string;
  phase: GitHubInstallationPhase;
  item_version: number;
  session_generation: number;
  current_run_id: string | null;
  checkpoint: string;
  authority: string;
  status: "pending" | "verified" | "revoked";
};

const RECENT_READY_MS = 10 * 60_000;
const UNREACHABLE_STATUS_MS = 10 * 60_000;
const TRANSIENT_CHECK_ERROR =
  /fetch failed|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|getaddrinfo|EHOSTUNREACH|ENETUNREACH|socket|network|rate.?limit|\b429\b|\b5\d\d\b|temporarily unavailable/i;

type Unreachable = { unreachable: string };

type Stamp = {
  version: number;
  checkpoint: string;
  runId: string | null;
  generation: number;
  authority: string;
};

/**
 * Holds an item until the workspace GitHub App installation covers its repository.
 *
 * `ensure` returns true when the installation covers the repository with the needed access and
 * the delegating member is still permitted. Otherwise it posts one `github-auth` waiting question
 * and returns false; `recover` resumes the item when the installation returns. An item whose
 * member lost access is cancelled.
 */
export class GitHubInstallationCheck {
  private closed = false;
  private readonly outages = new Map<string, { since: number; posted: boolean }>();
  private readonly lastReady = new Map<
    string,
    {
      authority: string;
      generation: number;
      runId: string | null;
      checkpoint: string;
      at: number;
      reusable: boolean;
    }
  >();

  constructor(
    private readonly store: Db,
    private readonly integration: GitHubIntegration,
    private readonly now: () => number,
    private readonly allowed: (q: Q, item: WorkItemRecord) => Steps<boolean> = () =>
      syncSteps(() => true),
  ) {}

  async owns(questionId: string): Promise<boolean> {
    return (await githubIntegrationHoldStatus(this.store, questionId)) !== null;
  }

  close(): void {
    this.closed = true;
  }

  async invalidate(scope: { sessionId?: string; issueId?: string } = {}): Promise<void> {
    for (const [itemId, ready] of this.lastReady) {
      const item = await this.store.run((q) => getWorkItemSteps(q, itemId));
      if (
        item === null ||
        ((scope.sessionId === undefined || item.sessionKey === scope.sessionId) &&
          (scope.issueId === undefined ||
            item.linearIssueId === scope.issueId ||
            (item.sessionKey !== null &&
              (await getLinearSession(this.store, item.sessionKey))?.issueId === scope.issueId)))
      )
        ready.reusable = false;
    }
  }

  async revoke(itemId: string): Promise<void> {
    await setGithubIntegrationHoldStatus(this.store, { itemId }, "revoked");
  }

  async ensure(
    item: WorkItemRecord,
    phase: GitHubInstallationPhase,
    signal: AbortSignal,
    options: { fresh?: boolean } = {},
  ): Promise<boolean> {
    const version = item.version;
    const { generation, authority } = await this.store.run((q) => this.stampSteps(q, item));
    const checkpoint = JSON.stringify(item.checkpoint);
    const runId = item.currentRunId;
    if (this.closed || signal.aborted) return false;
    const before = await this.store.run((q) => this.permissionSteps(q, item));
    if (before !== true) {
      await this.deny(item.id, before.reason);
      return false;
    }
    const result =
      !options.fresh && this.reusable(item, authority, generation)
        ? "ready"
        : await this.reachable(item, signal);
    if (this.closed || signal.aborted || isUnreachable(result)) return false;
    const held = { version, checkpoint, runId, generation, authority };
    const current = await this.store.run((q) => this.unchangedSteps(q, item.id, held));
    if (this.closed || signal.aborted || current === null) return false;
    const permission = await this.store.run((q) => this.permissionSteps(q, current));
    if (permission !== true) {
      await this.deny(current.id, permission.reason);
      return false;
    }
    if (typeof result === "object") {
      await this.deny(current.id, result.reason);
      return false;
    }
    if (result === "ready") return true;
    const notifications = { ready: false };
    await this.store.transaction((q) =>
      this.holdSteps(q, item.id, phase, held, result, notifications),
    );
    if (notifications.ready) emitJobReady(this.store);
    return false;
  }

  private *stampSteps(
    q: Q,
    item: WorkItemRecord,
  ): Steps<{ generation: number; authority: string }> {
    const generation = yield* this.generationSteps(q, item);
    const authority = yield* this.integration.identity(q, item);
    return { generation, authority };
  }

  private *unchangedSteps(q: Q, itemId: string, held: Stamp): Steps<WorkItemRecord | null> {
    const current = yield* getWorkItemSteps(q, itemId);
    if (
      current?.version !== held.version ||
      current.cancelRequested ||
      JSON.stringify(current.checkpoint) !== held.checkpoint ||
      current.currentRunId !== held.runId ||
      (yield* this.generationSteps(q, current)) !== held.generation ||
      (yield* this.integration.identity(q, current)) !== held.authority
    )
      return null;
    return current;
  }

  private *holdSteps(
    q: Q,
    itemId: string,
    phase: GitHubInstallationPhase,
    held: Stamp,
    result: "installation" | "unavailable",
    notifications: { ready: boolean },
  ): Steps<void> {
    const latest = yield* this.unchangedSteps(q, itemId, held);
    if (!latest?.sessionKey) return;
    const latestPermission = yield* this.permissionSteps(q, latest);
    if (latestPermission !== true) {
      yield* this.denySteps(q, latest.id, latestPermission.reason, notifications);
      return;
    }
    if ((yield* findOpenQuestionSteps(q, latest.sessionKey)) !== null) return;
    const body = waitingMessage(result);
    const { question } = yield* askSteps(
      q,
      { itemId: latest.id, runId: null, sessionId: latest.sessionKey, version: latest.version },
      "github-auth",
      body,
      { now: this.now() },
    );
    const asked = (yield* getWorkItemSteps(q, latest.id))!;
    yield* insertGithubIntegrationHoldSteps(q, {
      questionId: question.id,
      itemId: asked.id,
      phase,
      itemVersion: asked.version,
      sessionGeneration: held.generation,
      currentRunId: asked.currentRunId,
      checkpoint: JSON.stringify(asked.checkpoint),
      authority: yield* this.integration.identity(q, asked),
    });
    yield* enqueueOutboxOnceSteps(q, {
      target: "linear",
      op: "activity",
      orderingKey: latest.sessionKey,
      idempotencyKey: `github-integration:waiting:${question.id}`,
      payload: { sessionId: latest.sessionKey, kind: "thought", body },
      now: this.now(),
    });
    if (result === "installation")
      yield* this.notifyAdministratorsSteps(q, latest, question.id, latest.sessionKey);
  }

  async recover(signal: AbortSignal = new AbortController().signal): Promise<void> {
    if (this.closed || signal.aborted) return;
    const holds = (await this.store.run(pendingGithubIntegrationHoldsSteps)) as Hold[];
    for (const hold of holds) {
      if (this.closed || signal.aborted) return;
      if (!(await this.store.run((q) => this.currentSteps(q, hold)))) {
        await this.cancelObsolete(hold.item_id, hold.question_id);
        continue;
      }
      const item = (await this.store.run((q) => getWorkItemSteps(q, hold.item_id)))!;
      const result = await this.probe(item, signal, []);
      if (this.closed || signal.aborted) return;
      if (isUnreachable(result)) continue;
      if (typeof result === "object") {
        if (await this.store.run((q) => this.currentSteps(q, hold)))
          await this.deny(item.id, result.reason);
        continue;
      }
      if (result !== "ready") {
        await this.store.transaction((q) => this.rewaitSteps(q, hold, result));
        if (result === "installation")
          await this.store.transaction((q) => this.renotifySteps(q, hold, item));
        continue;
      }
      if (await this.store.transaction((q) => this.revalidateSteps(q, hold)))
        emitJobReady(this.store);
    }
  }

  private *rewaitSteps(q: Q, hold: Hold, result: "installation" | "unavailable"): Steps<void> {
    if (!(yield* this.currentSteps(q, hold))) return;
    const question = (yield* getQuestionSteps(q, hold.question_id))!;
    const body = waitingMessage(result);
    if (question.body === body) return;
    yield* setOpenQuestionBodySteps(q, question.id, body);
    yield* enqueueOutboxOnceSteps(q, {
      target: "linear",
      op: "activity",
      orderingKey: question.sessionId,
      idempotencyKey: `github-integration:waiting:${question.id}:${result}`,
      payload: { sessionId: question.sessionId, kind: "thought", body },
      now: this.now(),
    });
  }

  private *renotifySteps(q: Q, hold: Hold, item: WorkItemRecord): Steps<void> {
    if (!(yield* this.currentSteps(q, hold))) return;
    const question = (yield* getQuestionSteps(q, hold.question_id))!;
    yield* this.notifyAdministratorsSteps(q, item, question.id, question.sessionId);
  }

  private *revalidateSteps(q: Q, hold: Hold): Steps<boolean> {
    if (!(yield* this.currentSteps(q, hold))) return false;
    const question = (yield* getQuestionSteps(q, hold.question_id))!;
    yield* answerSteps(
      q,
      {
        sessionId: question.sessionId,
        deliveryId: `github-integration:${question.id}`,
        body: "Workspace GitHub App repository access revalidated by Paws.",
        answeredBy: "paws",
        now: this.now(),
      },
      { "github-auth": (tx, answered) => this.resumeSteps(tx, hold, answered) },
    );
    return true;
  }

  private *resumeSteps(q: Q, hold: Hold, question: StoredQuestion): Steps<void> {
    if (question.id !== hold.question_id)
      throw new Error("A GitHub App hold answer reached another question.");
    yield* setGithubIntegrationHoldStatusSteps(q, { questionId: question.id }, "verified");
    yield* applyWorkItemEventSteps(
      q,
      hold.item_id,
      hold.phase === "publication" ? "reverify_requested" : "answer_received",
      { now: this.now() },
    );
    yield* enqueueJobOnceSteps(q, {
      queue: hold.phase === "initial" ? JOB_KIND.resume : JOB_KIND.reverify,
      jobKey: `github-integration:${question.id}`,
      payload: { itemId: hold.item_id, reason: "github-integration" },
      now: this.now(),
    });
    yield* enqueueOutboxOnceSteps(q, {
      target: "linear",
      op: "activity",
      orderingKey: question.sessionId,
      idempotencyKey: `github-integration:verified:${question.id}`,
      payload: {
        sessionId: question.sessionId,
        kind: "thought",
        body: "Workspace GitHub App access restored. Revalidating your task before continuing.",
      },
      now: this.now(),
    });
  }

  private async reachable(
    item: WorkItemRecord,
    signal: AbortSignal,
  ): Promise<"ready" | "installation" | "unavailable" | Denied | Unreachable> {
    for (;;) {
      const result = await this.probe(item, signal);
      if (!isUnreachable(result) || this.closed || signal.aborted) {
        this.outages.delete(item.id);
        return result;
      }
      const outage = this.outages.get(item.id) ?? { since: this.now(), posted: false };
      if (!this.outages.has(item.id)) {
        this.outages.set(item.id, outage);
        journalCaught(
          new Error(result.unreachable),
          "github-integration.reachable.outage",
          item.id,
          "retrying quietly until GitHub answers",
        );
      }
      if (!outage.posted && item.sessionKey && this.now() - outage.since > UNREACHABLE_STATUS_MS) {
        outage.posted = true;
        const sessionId = item.sessionKey;
        await this.store.transaction((q) =>
          enqueueOutboxOnceSteps(q, {
            target: "linear",
            op: "activity",
            orderingKey: sessionId,
            idempotencyKey: `github-integration:unreachable:${item.id}:${outage.since}`,
            payload: {
              sessionId,
              kind: "thought",
              body: `Can't reach GitHub: ${result.unreachable}. Paws keeps retrying before continuing.`,
            },
            now: this.now(),
          }),
        );
      }
      await sleep(this.integration.unavailableRetryMs?.at(-1) ?? 60_000, signal);
    }
  }

  private async probe(
    item: WorkItemRecord,
    signal: AbortSignal,
    retryMs: readonly number[] = this.integration.unavailableRetryMs ?? [],
  ): Promise<"ready" | "installation" | "unavailable" | Denied | Unreachable> {
    try {
      const result = await this.check(item, signal);
      if (result === "ready") {
        const { generation, authority } = await this.store.run((q) => this.stampSteps(q, item));
        this.lastReady.set(item.id, {
          authority,
          generation,
          runId: item.currentRunId,
          checkpoint: JSON.stringify(item.checkpoint),
          at: this.now(),
          reusable: true,
        });
      } else this.lastReady.delete(item.id);
      return result;
    } catch (error) {
      journalCaught(
        error,
        "github-integration.probe.check",
        item?.id,
        "cancellation may interrupt work",
      );
      const limited =
        error instanceof LinearRateLimitError
          ? error.retryAfterMs
          : error instanceof Error && /\bRATELIMITED\b/.test(error.message)
            ? 60_000
            : null;
      if (limited !== null && !this.closed && !signal.aborted) {
        await sleep(limited, signal);
        if (!this.closed && !signal.aborted) return this.probe(item, signal, retryMs);
      }
      const [delay, ...rest] = retryMs;
      if (delay !== undefined && !this.closed && !signal.aborted) {
        await sleep(delay, signal);
        if (!this.closed && !signal.aborted) return this.probe(item, signal, rest);
      }
      const last = this.lastReady.get(item.id);
      const message = error instanceof Error ? error.message : String(error);
      if (!TRANSIENT_CHECK_ERROR.test(message) && !isTransient(error)) return "unavailable";
      return last !== undefined &&
        last.authority === (await this.store.run((q) => this.integration.identity(q, item))) &&
        this.now() - last.at <= RECENT_READY_MS
        ? "ready"
        : { unreachable: message };
    }
  }

  private reusable(item: WorkItemRecord, authority: string, generation: number): boolean {
    const last = this.lastReady.get(item.id);
    return (
      last !== undefined &&
      last.reusable &&
      last.authority === authority &&
      last.generation === generation &&
      last.runId === item.currentRunId &&
      last.checkpoint === JSON.stringify(item.checkpoint) &&
      this.now() - last.at < TASK_ACCESS_TTL_MS
    );
  }

  private async check(
    item: WorkItemRecord,
    signal: AbortSignal,
  ): Promise<"ready" | "installation" | Denied> {
    const ready = await this.integration.check(item, signal);
    const authorized = this.integration.authorize
      ? denial(await this.integration.authorize(item, signal))
      : true;
    if (authorized !== true) return authorized;
    return ready ? "ready" : "installation";
  }

  /** Cancels the item once. A reason replaces the default "Cancelled from Linear." response. */
  private async deny(itemId: string, reason: string | null): Promise<void> {
    const notifications = { ready: false };
    await this.store.transaction((q) => this.denySteps(q, itemId, reason, notifications));
    if (notifications.ready) emitJobReady(this.store);
  }

  private *denySteps(
    q: Q,
    itemId: string,
    reason: string | null,
    notifications: { ready: boolean },
  ): Steps<void> {
    yield* applyLinearCommandSteps(
      q,
      { type: "cancel", source: "linear", itemId, requestedAt: this.now() },
      this.now(),
      reason ?? undefined,
      {},
      commandInstance(this.store),
      notifications,
    );
    yield* setGithubIntegrationHoldStatusSteps(q, { itemId }, "revoked");
  }

  private *notifyAdministratorsSteps(
    q: Q,
    item: WorkItemRecord,
    questionId: string,
    sessionId: string,
  ): Steps<void> {
    for (const administrator of new Set(yield* this.integration.administrators(q, item))) {
      yield* enqueueOutboxOnceSteps(q, {
        target: "linear",
        op: "elicitation",
        orderingKey: sessionId,
        idempotencyKey: `github-integration:admin:${questionId}:${administrator}`,
        payload: {
          id: crypto.randomUUID(),
          questionId,
          sessionId: sessionId,
          body: "Restore the workspace GitHub App installation and approved repository access, then revalidate the integration in Paws.",
          auth: {
            url: this.integration.recoveryUrl,
            userId: administrator,
            providerName: "GitHub",
          },
        },
        now: this.now(),
      });
    }
  }

  private async cancelObsolete(itemId: string, questionId: string): Promise<void> {
    const notifications = { ready: false };
    await this.store.transaction((q) =>
      this.cancelObsoleteSteps(q, itemId, questionId, notifications),
    );
    if (notifications.ready) emitJobReady(this.store);
  }

  private *cancelObsoleteSteps(
    q: Q,
    itemId: string,
    questionId: string,
    notifications: { ready: boolean },
  ): Steps<void> {
    yield* setGithubIntegrationHoldStatusSteps(q, { questionId }, "revoked");
    const item = yield* getWorkItemSteps(q, itemId);
    if (
      item?.state === "awaiting_input" &&
      (yield* getQuestionSteps(q, questionId))?.status === "open"
    )
      yield* applyLinearCommandSteps(
        q,
        { type: "cancel", source: "linear", itemId, requestedAt: this.now() },
        this.now(),
        undefined,
        {},
        commandInstance(this.store),
        notifications,
      );
  }

  private *permissionSteps(q: Q, item: WorkItemRecord): Steps<true | Denied> {
    if (!(yield* this.allowed(q, item))) return { denied: true, reason: null };
    return denial(this.integration.current ? yield* this.integration.current(q, item) : true);
  }

  private *generationSteps(q: Q, item: WorkItemRecord): Steps<number> {
    return item.sessionKey ? yield* getLinearSessionGenerationSteps(q, item.sessionKey) : 0;
  }

  private *currentSteps(q: Q, hold: Hold): Steps<boolean> {
    const item = yield* getWorkItemSteps(q, hold.item_id);
    return (
      !this.closed &&
      item !== null &&
      !item.cancelRequested &&
      item.state === "awaiting_input" &&
      item.version === hold.item_version &&
      item.currentRunId === hold.current_run_id &&
      JSON.stringify(item.checkpoint) === hold.checkpoint &&
      (yield* this.integration.identity(q, item)) === hold.authority &&
      (yield* this.generationSteps(q, item)) === hold.session_generation &&
      (yield* this.permissionSteps(q, item)) === true &&
      (yield* getQuestionSteps(q, hold.question_id))?.status === "open" &&
      (yield* githubIntegrationHoldStatusSteps(q, hold.question_id)) === "pending"
    );
  }
}

function isUnreachable(result: unknown): result is Unreachable {
  return typeof result === "object" && result !== null && "unreachable" in result;
}

function denial(result: boolean | GitHubDenial): true | Denied {
  if (result === true) return true;
  return { denied: true, reason: result === false ? null : result.reason };
}

function waitingMessage(result: "unavailable" | "installation"): string {
  return result === "unavailable"
    ? "Workspace authorization could not be checked. Paws will retry automatically before continuing; no personal GitHub sign-in is required."
    : "Waiting for a workspace admin to restore the GitHub App installation and repository access. Your personal GitHub sign-in is not required.";
}
