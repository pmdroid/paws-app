import type { Database } from "bun:sqlite";
import { GitHubIntegrationHolds, type GitHubIntegration } from "./github-integration";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  enqueueJobOnce,
  enqueueOutboxOnce,
  getWorkItem,
  getLinearSessionGeneration,
  immediate,
  type WorkItemRecord,
} from "../db";
import {
  answer,
  ask,
  canAnswer,
  findOpenQuestion,
  getQuestion,
  type StoredQuestion,
} from "../questions";

export type GitHubAuthPhase = "initial" | "publication";
export type VerifiedGitHubAccount = { id: number; login: string };
export type HostGitHubAuth = {
  integration?: GitHubIntegration;
  recoveryMessage?: string;
  externalLogin?: boolean;
  owner(item: WorkItemRecord): string | null;
  check(item: WorkItemRecord, signal: AbortSignal): Promise<VerifiedGitHubAccount | null>;
  linkedAccount(item: WorkItemRecord): Promise<number | null>;
  begin(
    item: WorkItemRecord,
    input: { signal: AbortSignal; acceptAccount: (id: number) => boolean },
  ): Promise<{ url: string; body?: string; completed: Promise<VerifiedGitHubAccount> }>;
};

type AuthRequest = {
  question_id: string;
  item_id: string;
  actor_id: string;
  github_account_id: number | null;
  phase: GitHubAuthPhase;
  generation: number;
  session_generation: number;
  status: "pending" | "verified" | "expired" | "revoked";
  expires_at: number;
};

const AUTH_LIFETIME_MS = 10 * 60_000;

export class GitHubAuthQuestions {
  private readonly integration: GitHubIntegrationHolds | null;
  private readonly active = new Map<string, AbortController>();
  private closed = false;
  private readonly checks = new Map<string, AbortController>();

  constructor(
    private readonly db: Database,
    private readonly host: HostGitHubAuth,
    private readonly now: () => number,
    private readonly allowed: (item: WorkItemRecord) => boolean = () => true,
  ) {
    this.integration = host.integration
      ? new GitHubIntegrationHolds(db, host.integration, allowed, now)
      : null;
  }

  invalidate(scope: { sessionId?: string; issueId?: string } = {}): void {
    this.integration?.invalidate(scope);
  }

  owns(questionId: string): boolean {
    return !this.closed && (this.integration?.owns(questionId) || this.read(questionId) !== null);
  }

  async ensure(
    item: WorkItemRecord,
    phase: GitHubAuthPhase,
    signal: AbortSignal,
    options: { fresh?: boolean } = {},
  ): Promise<boolean> {
    if (this.closed) return false;
    if (this.integration) return this.integration.ensure(item, phase, signal, options);
    const sessionGeneration = item.sessionKey
      ? getLinearSessionGeneration(this.db, item.sessionKey)
      : 0;
    const isCurrent = () =>
      !this.closed &&
      !signal.aborted &&
      this.allowed(item) &&
      (item.sessionKey === null ||
        getLinearSessionGeneration(this.db, item.sessionKey) === sessionGeneration);
    if (!isCurrent()) return false;
    const account = await this.host.check(item, signal);
    if (!isCurrent()) return false;
    signal.throwIfAborted();
    const expected = await this.host.linkedAccount(item);
    signal.throwIfAborted();
    if (!isCurrent()) return false;
    const bound = this.accountFor(item.id);
    const accountId = bound ?? expected;
    if (
      account !== null &&
      (accountId === null || account.id === accountId) &&
      (expected === null ? bound === null || this.host.externalLogin : account.id === expected)
    ) {
      this.bindAccount(item.id, account);
      return true;
    }
    const actorId = this.host.owner(item);
    if (actorId === null)
      throw new Error("The Linear task owner must be verified before GitHub sign-in.");
    if (accountId === null)
      throw new Error("Sign in to GitHub in Paws before connecting this Linear task.");
    const sessionId = item.sessionKey;
    if (sessionId === null)
      throw new Error("The Linear task needs an agent session before GitHub sign-in.");
    const request = immediate(this.db, () => {
      const current = getWorkItem(this.db, item.id);
      if (current === null || current.cancelRequested || current.state !== item.state) return null;
      const existing = findOpenQuestion(this.db, sessionId);
      if (existing !== null) return this.read(existing.id);
      const { question } = ask(
        this.db,
        { itemId: item.id, runId: null, sessionId },
        "github-auth",
        "Sign in to GitHub to continue.",
        { now: this.now() },
      );
      applyWorkItemEvent(this.db, item.id, "blocking_question");
      this.db.run(
        "INSERT INTO linear_github_auth (question_id,item_id,actor_id,github_account_id,phase,expires_at,session_generation) VALUES (?,?,?,?,?,?,?)",
        [
          question.id,
          item.id,
          actorId,
          accountId,
          phase,
          this.now() + AUTH_LIFETIME_MS,
          sessionGeneration,
        ],
      );
      return this.read(question.id);
    });
    if (request !== null) await this.start(request);
    return false;
  }

  async recover(signal: AbortSignal = new AbortController().signal): Promise<void> {
    if (this.closed || signal.aborted) return;
    if (this.integration) return this.integration.recover(signal);
    const requests = this.db
      .query<AuthRequest, []>("SELECT * FROM linear_github_auth WHERE status = 'pending'")
      .all();
    for (const request of requests) {
      if (this.closed || signal.aborted) return;
      if (!this.valid(request)) {
        if (request.expires_at <= this.now()) {
          this.expire(request);
        } else {
          this.revoke(request.item_id);
        }
        continue;
      }
      const item = getWorkItem(this.db, request.item_id)!;
      const account = await this.host.check(item, signal).catch(() => null);
      if (this.closed || signal.aborted) return;
      const expected = await this.host.linkedAccount(item);
      if (this.closed || signal.aborted) return;
      if (
        expected !== request.github_account_id &&
        !(this.host.externalLogin && expected === null)
      ) {
        this.pause(request);
        continue;
      }
      if (account !== null && account.id === request.github_account_id) {
        await this.complete(request, account, signal);
      } else {
        await this.start(request);
      }
    }
  }

  revoke(itemId: string): void {
    if (this.closed) return;
    this.integration?.revoke(itemId);
    for (const [questionId, controller] of this.checks)
      if (this.read(questionId)?.item_id === itemId) controller.abort();
    for (const [questionId, controller] of this.active) {
      if (this.read(questionId)?.item_id !== itemId) continue;
      controller.abort();
      this.active.delete(questionId);
    }
    this.db.run(
      "UPDATE linear_github_auth SET status = 'revoked',generation = generation + 1 WHERE item_id = ? AND status IN ('pending','expired')",
      [itemId],
    );
  }

  close(): void {
    this.closed = true;
    this.integration?.close();
    for (const controller of this.checks.values()) controller.abort();
    this.checks.clear();
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
  }

  async retry(
    questionId: string,
    actorId: string | null,
    consume: () => void = () => {},
  ): Promise<boolean> {
    if (this.closed) return false;
    if (this.integration?.owns(questionId)) return false;
    const request = this.read(questionId);
    if (
      request === null ||
      actorId === null ||
      !canAnswer({ kind: "github-auth", actorId: request.actor_id }, { id: actorId }) ||
      this.checks.has(questionId) ||
      this.active.has(questionId) ||
      !this.current(request)
    )
      return false;
    const controller = new AbortController();
    this.checks.set(questionId, controller);
    try {
      const item = getWorkItem(this.db, request.item_id)!;
      const account = await this.host.check(item, controller.signal).catch(() => null);
      if (controller.signal.aborted || this.active.has(questionId) || !this.current(request))
        return false;
      const expected = await this.host.linkedAccount(item);
      if (controller.signal.aborted || this.active.has(questionId) || !this.current(request))
        return false;
      if (
        expected !== request.github_account_id &&
        !(this.host.externalLogin && expected === null)
      ) {
        this.pause(request);
        return false;
      }
      immediate(this.db, () => {
        this.db.run(
          "UPDATE linear_github_auth SET status = 'pending',expires_at = ?,generation = generation + 1 WHERE question_id = ?",
          [this.now() + AUTH_LIFETIME_MS, questionId],
        );
        consume();
      });
      const renewed = this.read(questionId)!;
      if (account?.id === renewed.github_account_id)
        await this.complete(renewed, account, controller.signal);
      else await this.start(renewed);
      return true;
    } finally {
      if (this.checks.get(questionId) === controller) this.checks.delete(questionId);
    }
  }

  private async start(previous: AuthRequest): Promise<void> {
    if (this.active.has(previous.question_id) || !this.valid(previous)) return;
    if (previous.github_account_id === null) return;
    const request = immediate(this.db, () => {
      this.db.run(
        "UPDATE linear_github_auth SET generation = generation + 1 WHERE question_id = ?",
        [previous.question_id],
      );
      this.dropPrompt(previous.question_id);
      return this.read(previous.question_id)!;
    });
    const controller = new AbortController();
    this.active.set(request.question_id, controller);
    const timeout = setTimeout(
      () => {
        if (controller.signal.aborted) return;
        this.expire(request);
      },
      Math.max(0, request.expires_at - this.now()),
    );
    timeout.unref?.();
    try {
      const item = getWorkItem(this.db, request.item_id)!;
      const challenge = await this.host.begin(item, {
        signal: controller.signal,
        acceptAccount: (id) =>
          !controller.signal.aborted && id === request.github_account_id && this.valid(request),
      });
      void challenge.completed.catch(() => undefined);
      if (!this.valid(request) || controller.signal.aborted) return;
      const question = getQuestion(this.db, request.question_id)!;
      enqueueOutboxOnce(this.db, {
        target: "linear",
        op: "elicitation",
        orderingKey: question.sessionId,
        idempotencyKey: `github-auth:${question.id}:${request.generation}`,
        payload: {
          id: crypto.randomUUID(),
          questionId: question.id,
          sessionId: question.sessionId,
          body: challenge.body ?? question.body,
          auth: { url: challenge.url, userId: request.actor_id, providerName: "GitHub" },
        },
        now: this.now(),
      });
      void challenge.completed
        .then((account) => {
          if (!controller.signal.aborted) return this.complete(request, account, controller.signal);
        })
        .catch(() => this.failed(request))
        .finally(() => {
          clearTimeout(timeout);
          if (this.active.get(request.question_id) === controller)
            this.active.delete(request.question_id);
        });
    } catch {
      clearTimeout(timeout);
      this.failed(request);
      if (this.active.get(request.question_id) === controller)
        this.active.delete(request.question_id);
    }
  }

  private failed(request: AuthRequest): void {
    if (!this.valid(request)) return;
    immediate(this.db, () => {
      const question = getQuestion(this.db, request.question_id)!;
      this.dropPrompt(question.id);
      enqueueOutboxOnce(this.db, {
        target: "linear",
        op: "elicitation",
        orderingKey: question.sessionId,
        idempotencyKey: `github-auth:retry:${question.id}:${request.generation}`,
        payload: {
          id: crypto.randomUUID(),
          questionId: question.id,
          sessionId: question.sessionId,
          body:
            this.host.recoveryMessage ??
            "GitHub sign-in could not finish. Reply here to try again.",
        },
        now: this.now(),
      });
    });
  }

  private dropPrompt(questionId: string): void {
    this.db.run(
      "UPDATE outbox SET status = 'dropped',locked_by = NULL,locked_until = NULL WHERE status IN ('pending','dead') AND op = 'elicitation' AND json_extract(payload,'$.questionId') = ?",
      [questionId],
    );
  }

  private async complete(
    request: AuthRequest,
    account: VerifiedGitHubAccount,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted || !this.valid(request) || account.id !== request.github_account_id) return;
    const expected = await this.host.linkedAccount(getWorkItem(this.db, request.item_id)!);
    if (signal?.aborted || !this.valid(request)) return;
    if (expected !== request.github_account_id && !(this.host.externalLogin && expected === null)) {
      this.pause(request);
      return;
    }
    immediate(this.db, () => {
      if (account.id !== request.github_account_id || !this.valid(request)) return;
      this.bindAccount(request.item_id, account);
      const question = getQuestion(this.db, request.question_id)!;
      answer(
        this.db,
        {
          sessionId: question.sessionId,
          deliveryId: `github-auth:${question.id}:${request.generation}`,
          body: `GitHub account ${account.login} verified by Paws.`,
          answeredBy: request.actor_id,
          now: this.now(),
        },
        { "github-auth": (answered) => this.resume(request, answered) },
      );
    });
    if (this.read(request.question_id)?.status === "verified") {
      this.active.get(request.question_id)?.abort();
      this.active.delete(request.question_id);
    }
  }

  private resume(request: AuthRequest, question: StoredQuestion): void {
    if (question.id !== request.question_id)
      throw new Error("A GitHub sign-in answer reached another question.");
    this.db.run(
      "UPDATE linear_github_auth SET status = 'verified',verified_at = ? WHERE question_id = ?",
      [this.now(), question.id],
    );
    applyWorkItemEvent(this.db, request.item_id, "answer_received");
    if (request.phase === "publication") applyWorkItemEvent(this.db, request.item_id, "turn_ended");
    enqueueOutboxOnce(this.db, {
      target: "linear",
      op: "activity",
      orderingKey: question.sessionId,
      idempotencyKey: `github-auth:verified:${question.id}`,
      payload: {
        sessionId: question.sessionId,
        kind: "thought",
        body: "GitHub account connected. Continuing your task.",
      },
      now: this.now(),
    });
    enqueueJobOnce(this.db, {
      queue: request.phase === "initial" ? JOB_KIND.resume : JOB_KIND.reverify,
      jobKey: `github-auth:${question.id}`,
      payload: { itemId: request.item_id, reason: "github-auth" },
      now: this.now(),
    });
  }

  private pause(request: AuthRequest): void {
    if (!this.current(request)) return;
    immediate(this.db, () => {
      this.db.run(
        "UPDATE linear_github_auth SET status = 'expired',generation = generation + 1 WHERE question_id = ? AND generation = ? AND status IN ('pending','expired')",
        [request.question_id, request.generation],
      );
      this.dropPrompt(request.question_id);
      const paused = this.read(request.question_id)!;
      const question = getQuestion(this.db, request.question_id)!;
      enqueueOutboxOnce(this.db, {
        target: "linear",
        op: "elicitation",
        orderingKey: question.sessionId,
        idempotencyKey: `github-auth:account:${question.id}:${paused.generation}`,
        payload: {
          id: crypto.randomUUID(),
          questionId: question.id,
          sessionId: question.sessionId,
          body: "Reconnect the original GitHub account on the Paws host, then reply here to continue.",
        },
        now: this.now(),
      });
    });
    this.active.get(request.question_id)?.abort();
    this.active.delete(request.question_id);
  }

  private expire(request: AuthRequest): void {
    immediate(this.db, () => {
      const expired = this.db.run(
        "UPDATE linear_github_auth SET status = 'expired' WHERE question_id = ? AND generation = ? AND status = 'pending'",
        [request.question_id, request.generation],
      );
      if (expired.changes === 0) return;
      this.dropPrompt(request.question_id);
    });
    this.active.get(request.question_id)?.abort();
    this.active.delete(request.question_id);
  }

  private valid(request: AuthRequest): boolean {
    if (this.closed) return false;
    return (
      this.read(request.question_id)?.status === "pending" &&
      request.expires_at > this.now() &&
      this.current(request)
    );
  }

  private current(request: AuthRequest): boolean {
    if (this.closed) return false;
    const persisted = this.read(request.question_id);
    const item = getWorkItem(this.db, request.item_id);
    const question = getQuestion(this.db, request.question_id);
    return (
      (persisted?.status === "pending" || persisted?.status === "expired") &&
      persisted.generation === request.generation &&
      item?.state === "awaiting_input" &&
      !item.cancelRequested &&
      this.allowed(item) &&
      (item.sessionKey === null ||
        getLinearSessionGeneration(this.db, item.sessionKey) === request.session_generation) &&
      this.host.owner(item) === request.actor_id &&
      question?.status === "open"
    );
  }

  private read(questionId: string): AuthRequest | null {
    return this.db
      .query<AuthRequest, [string]>("SELECT * FROM linear_github_auth WHERE question_id = ?")
      .get(questionId);
  }

  private accountFor(itemId: string): number | null {
    return (
      this.db
        .query<{ account_id: number }, [string]>(
          "SELECT account_id FROM linear_github_task_account WHERE item_id = ?",
        )
        .get(itemId)?.account_id ?? null
    );
  }

  private bindAccount(itemId: string, account: VerifiedGitHubAccount): void {
    this.db.run(
      "INSERT INTO linear_github_task_account (item_id,account_id,login,verified_at) VALUES (?,?,?,?) ON CONFLICT (item_id) DO NOTHING",
      [itemId, account.id, account.login, this.now()],
    );
    if (this.accountFor(itemId) !== account.id)
      throw new Error("The GitHub account does not match this task.");
  }
}
