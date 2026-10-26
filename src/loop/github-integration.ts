import { ask } from "./operations";
import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { JOB_KIND, sleep } from "../core";
import { LinearRateLimitError } from "../linear";
import {
  applyWorkItemEvent,
  applyLinearCommand,
  enqueueJobOnce,
  enqueueOutboxOnce,
  getLinearSession,
  getLinearSessionGeneration,
  getWorkItem,
  immediate,
  type WorkItemRecord,
} from "../db";
import { answer, findOpenQuestion, getQuestion, type StoredQuestion } from "../questions";

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

/** The delegator is not in the issue's team in Paws, or is an observer. */
export function notTeamMemberDenial(team: string): GitHubDenial {
  return { denied: true, reason: `You're not a member of ${team} in Paws.` };
}

function people(names: readonly string[]): string {
  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  if (unique.length === 0) return "a Paws owner or admin";
  if (unique.length === 1) return unique[0]!;
  return `${unique.slice(0, -1).join(", ")} or ${unique.at(-1)}`;
}

/** What the host knows about the workspace GitHub App installation for an item. */
export type GitHubIntegration = {
  check(item: WorkItemRecord, signal: AbortSignal): Promise<boolean>;
  /** False, or a `GitHubDenial` with its reason, cancels the item. */
  authorize?(item: WorkItemRecord, signal: AbortSignal): Promise<boolean | GitHubDenial>;
  administrators(item: WorkItemRecord): readonly string[];
  recoveryUrl: string;
  identity(item: WorkItemRecord): string;
  /** False, or a `GitHubDenial` with its reason, cancels the item without a read. */
  current?(item: WorkItemRecord): boolean | GitHubDenial;
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
const TRANSIENT_CHECK_ERROR =
  /fetch failed|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket|network|rate.?limit|\b429\b|\b5\d\d\b|temporarily unavailable/i;

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
    private readonly db: Database,
    private readonly integration: GitHubIntegration,
    private readonly now: () => number,
    private readonly allowed: (item: WorkItemRecord) => boolean = () => true,
  ) {}

  owns(questionId: string): boolean {
    return (
      this.db.query("SELECT 1 FROM github_integration_hold WHERE question_id=?").get(questionId) !==
      null
    );
  }

  close(): void {
    this.closed = true;
  }

  invalidate(scope: { sessionId?: string; issueId?: string } = {}): void {
    for (const [itemId, ready] of this.lastReady) {
      const item = getWorkItem(this.db, itemId);
      if (
        item === null ||
        ((scope.sessionId === undefined || item.sessionKey === scope.sessionId) &&
          (scope.issueId === undefined ||
            item.linearIssueId === scope.issueId ||
            (item.sessionKey !== null &&
              getLinearSession(this.db, item.sessionKey)?.issueId === scope.issueId)))
      )
        ready.reusable = false;
    }
  }

  revoke(itemId: string): void {
    this.db.run(
      "UPDATE github_integration_hold SET status='revoked' WHERE item_id=? AND status='pending'",
      [itemId],
    );
  }

  async ensure(
    item: WorkItemRecord,
    phase: GitHubInstallationPhase,
    signal: AbortSignal,
    options: { fresh?: boolean } = {},
  ): Promise<boolean> {
    const version = item.version;
    const generation = this.generation(item);
    const authority = this.integration.identity(item);
    const checkpoint = JSON.stringify(item.checkpoint);
    const runId = item.currentRunId;
    if (this.closed || signal.aborted) return false;
    const before = this.permission(item);
    if (before !== true) {
      this.deny(item.id, before.reason);
      return false;
    }
    const result =
      !options.fresh && this.reusable(item, authority, generation)
        ? "ready"
        : await this.probe(item, signal);
    if (this.closed || signal.aborted) return false;
    const current = getWorkItem(this.db, item.id);
    if (
      this.closed ||
      signal.aborted ||
      current?.version !== version ||
      current.cancelRequested ||
      JSON.stringify(current.checkpoint) !== checkpoint ||
      current.currentRunId !== runId ||
      this.generation(current) !== generation ||
      this.integration.identity(current) !== authority
    )
      return false;
    const permission = this.permission(current);
    if (permission !== true) {
      this.deny(current.id, permission.reason);
      return false;
    }
    if (typeof result === "object") {
      this.deny(current.id, result.reason);
      return false;
    }
    if (result === "ready") return true;
    immediate(this.db, () => {
      const latest = getWorkItem(this.db, item.id);
      if (
        !latest?.sessionKey ||
        latest.version !== version ||
        latest.cancelRequested ||
        JSON.stringify(latest.checkpoint) !== checkpoint ||
        latest.currentRunId !== runId ||
        this.generation(latest) !== generation ||
        this.integration.identity(latest) !== authority
      )
        return;
      const latestPermission = this.permission(latest);
      if (latestPermission !== true) {
        this.deny(latest.id, latestPermission.reason);
        return;
      }
      if (findOpenQuestion(this.db, latest.sessionKey) !== null) return;
      const body = waitingMessage(result);
      const { question } = ask(
        this.db,
        { itemId: latest.id, runId: null, sessionId: latest.sessionKey, version: latest.version },
        "github-auth",
        body,
        { now: this.now() },
      );
      const held = getWorkItem(this.db, latest.id)!;
      this.db.run(
        "INSERT INTO github_integration_hold(question_id,item_id,phase,item_version,session_generation,current_run_id,checkpoint,authority) VALUES(?,?,?,?,?,?,?,?)",
        [
          question.id,
          held.id,
          phase,
          held.version,
          generation,
          held.currentRunId,
          JSON.stringify(held.checkpoint),
          this.integration.identity(held),
        ],
      );
      enqueueOutboxOnce(this.db, {
        target: "linear",
        op: "activity",
        orderingKey: latest.sessionKey,
        idempotencyKey: `github-integration:waiting:${question.id}`,
        payload: { sessionId: latest.sessionKey, kind: "thought", body },
        now: this.now(),
      });
      if (result === "installation")
        this.notifyAdministrators(latest, question.id, latest.sessionKey);
    });
    return false;
  }

  async recover(signal: AbortSignal = new AbortController().signal): Promise<void> {
    if (this.closed || signal.aborted) return;
    const holds = this.db
      .query<Hold, []>("SELECT * FROM github_integration_hold WHERE status='pending'")
      .all();
    for (const hold of holds) {
      if (this.closed || signal.aborted) return;
      if (!this.current(hold)) {
        this.cancelObsolete(hold.item_id, hold.question_id);
        continue;
      }
      const item = getWorkItem(this.db, hold.item_id)!;
      const result = await this.probe(item, signal, []);
      if (this.closed || signal.aborted) return;
      if (typeof result === "object") {
        if (this.current(hold)) this.deny(item.id, result.reason);
        continue;
      }
      if (result !== "ready") {
        immediate(this.db, () => {
          if (!this.current(hold)) return;
          const question = getQuestion(this.db, hold.question_id)!;
          const body = waitingMessage(result);
          if (question.body === body) return;
          this.db.run("UPDATE question SET body=? WHERE id=? AND status='open'", [
            body,
            question.id,
          ]);
          enqueueOutboxOnce(this.db, {
            target: "linear",
            op: "activity",
            orderingKey: question.sessionId,
            idempotencyKey: `github-integration:waiting:${question.id}:${result}`,
            payload: { sessionId: question.sessionId, kind: "thought", body },
            now: this.now(),
          });
        });
        if (result === "installation" && this.current(hold)) {
          const question = getQuestion(this.db, hold.question_id)!;
          this.notifyAdministrators(item, question.id, question.sessionId);
        }
        continue;
      }
      immediate(this.db, () => {
        if (!this.current(hold)) return;
        const question = getQuestion(this.db, hold.question_id)!;
        answer(
          this.db,
          {
            sessionId: question.sessionId,
            deliveryId: `github-integration:${question.id}`,
            body: "Workspace GitHub App repository access revalidated by Paws.",
            answeredBy: "paws",
            now: this.now(),
          },
          { "github-auth": (answered) => this.resume(hold, answered) },
        );
      });
    }
  }

  private resume(hold: Hold, question: StoredQuestion): void {
    if (question.id !== hold.question_id)
      throw new Error("A GitHub App hold answer reached another question.");
    this.db.run(
      "UPDATE github_integration_hold SET status='verified' WHERE question_id=? AND status='pending'",
      [question.id],
    );
    applyWorkItemEvent(this.db, hold.item_id, "answer_received");
    if (hold.phase === "publication") applyWorkItemEvent(this.db, hold.item_id, "turn_ended");
    enqueueJobOnce(this.db, {
      queue: hold.phase === "initial" ? JOB_KIND.resume : JOB_KIND.reverify,
      jobKey: `github-integration:${question.id}`,
      payload: { itemId: hold.item_id, reason: "github-integration" },
      now: this.now(),
    });
    enqueueOutboxOnce(this.db, {
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

  private async probe(
    item: WorkItemRecord,
    signal: AbortSignal,
    retryMs: readonly number[] = this.integration.unavailableRetryMs ?? [],
  ): Promise<"ready" | "installation" | "unavailable" | Denied> {
    try {
      const result = await this.check(item, signal);
      if (result === "ready")
        this.lastReady.set(item.id, {
          authority: this.integration.identity(item),
          generation: this.generation(item),
          runId: item.currentRunId,
          checkpoint: JSON.stringify(item.checkpoint),
          at: this.now(),
          reusable: true,
        });
      else this.lastReady.delete(item.id);
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
      return TRANSIENT_CHECK_ERROR.test(message) &&
        last !== undefined &&
        last.authority === this.integration.identity(item) &&
        this.now() - last.at <= RECENT_READY_MS
        ? "ready"
        : "unavailable";
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
  private deny(itemId: string, reason: string | null = null): void {
    immediate(this.db, () => {
      applyLinearCommand(
        this.db,
        { type: "cancel", source: "linear", itemId, requestedAt: this.now() },
        this.now(),
        reason ?? undefined,
      );
      this.revoke(itemId);
    });
  }

  private notifyAdministrators(item: WorkItemRecord, questionId: string, sessionId: string): void {
    for (const administrator of new Set(this.integration.administrators(item))) {
      enqueueOutboxOnce(this.db, {
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

  private cancelObsolete(itemId: string, questionId: string): void {
    immediate(this.db, () => {
      this.db.run(
        "UPDATE github_integration_hold SET status='revoked' WHERE question_id=? AND status='pending'",
        [questionId],
      );
      const item = getWorkItem(this.db, itemId);
      if (item?.state === "awaiting_input" && getQuestion(this.db, questionId)?.status === "open") {
        applyLinearCommand(
          this.db,
          { type: "cancel", source: "linear", itemId, requestedAt: this.now() },
          this.now(),
        );
      }
    });
  }

  private permitted(item: WorkItemRecord): boolean {
    return this.permission(item) === true;
  }

  private permission(item: WorkItemRecord): true | Denied {
    if (!this.allowed(item)) return { denied: true, reason: null };
    return denial(this.integration.current?.(item) ?? true);
  }

  private generation(item: WorkItemRecord): number {
    return item.sessionKey ? getLinearSessionGeneration(this.db, item.sessionKey) : 0;
  }

  private current(hold: Hold): boolean {
    const item = getWorkItem(this.db, hold.item_id);
    return (
      !this.closed &&
      item !== null &&
      !item.cancelRequested &&
      item.state === "awaiting_input" &&
      item.version === hold.item_version &&
      item.currentRunId === hold.current_run_id &&
      JSON.stringify(item.checkpoint) === hold.checkpoint &&
      this.integration.identity(item) === hold.authority &&
      this.generation(item) === hold.session_generation &&
      this.permitted(item) &&
      getQuestion(this.db, hold.question_id)?.status === "open" &&
      this.db
        .query<{ status: string }, [string]>(
          "SELECT status FROM github_integration_hold WHERE question_id=?",
        )
        .get(hold.question_id)?.status === "pending"
    );
  }
}

function denial(result: boolean | GitHubDenial): true | Denied {
  if (result === true) return true;
  return { denied: true, reason: result === false ? null : result.reason };
}

function waitingMessage(result: "unavailable" | "installation"): string {
  return result === "unavailable"
    ? "Workspace authorization could not be checked. Paws will retry automatically before continuing; no personal GitHub sign-in is required."
    : "Waiting for a workspace owner or administrator to restore the GitHub App installation and repository access. Your personal GitHub sign-in is not required.";
}
