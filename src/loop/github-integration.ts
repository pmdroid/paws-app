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
import { answerQuestion, findOpenQuestion, getQuestion, openQuestion } from "../questions";
import { TASK_ACCESS_TTL_MS } from "./linear-task-access";

export type GitHubIntegration = {
  attributionReady?(item: WorkItemRecord): Promise<boolean>;
  check(item: WorkItemRecord, signal: AbortSignal): Promise<boolean>;
  authorize?(item: WorkItemRecord, signal: AbortSignal): Promise<boolean>;
  administrators(item: WorkItemRecord): readonly string[];
  recoveryUrl: string;
  identity(item: WorkItemRecord): string;
  current?(item: WorkItemRecord): boolean;
  unavailableRetryMs?: readonly number[];
};

type Hold = {
  question_id: string;
  item_id: string;
  phase: "initial" | "publication";
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

export class GitHubIntegrationHolds {
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
    private readonly allowed: (item: WorkItemRecord) => boolean,
    private readonly now: () => number,
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
    phase: "initial" | "publication",
    signal: AbortSignal,
    options: { fresh?: boolean } = {},
  ): Promise<boolean> {
    const version = item.version;
    const generation = this.generation(item);
    const authority = this.integration.identity(item);
    const checkpoint = JSON.stringify(item.checkpoint);
    const runId = item.currentRunId;
    if (this.closed || signal.aborted) return false;
    if (!this.permitted(item)) {
      this.deny(item.id);
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
    if (!this.permitted(current) || result === "denied") {
      this.deny(current.id);
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
      if (!this.permitted(latest)) {
        this.deny(latest.id);
        return;
      }
      if (findOpenQuestion(this.db, latest.sessionKey) !== null) return;
      const body = waitingMessage(result);
      const question = openQuestion(this.db, {
        itemId: latest.id,
        sessionId: latest.sessionKey,
        body,
        now: this.now(),
      });
      const held = applyWorkItemEvent(this.db, latest.id, "blocking_question");
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

  async recover(signal: AbortSignal): Promise<void> {
    if (this.closed || signal.aborted) return;
    this.migrateLegacy();
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
      if (result === "denied") {
        if (this.current(hold)) this.deny(item.id);
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
        if (
          answerQuestion(this.db, question.id, {
            answer: "Workspace GitHub App repository access revalidated by Paws.",
            answeredBy: "paws",
            eventKey: `github-integration:${question.id}`,
            now: this.now(),
          }) === null
        )
          return;
        this.db.run(
          "UPDATE github_integration_hold SET status='verified' WHERE question_id=? AND status='pending'",
          [question.id],
        );
        applyWorkItemEvent(this.db, item.id, "answer_received");
        if (hold.phase === "publication") applyWorkItemEvent(this.db, item.id, "turn_ended");
        enqueueJobOnce(this.db, {
          queue: hold.phase === "initial" ? JOB_KIND.resume : JOB_KIND.reverify,
          jobKey: `github-integration:${question.id}`,
          payload: { itemId: item.id, reason: "github-integration" },
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
      });
    }
  }

  private async probe(
    item: WorkItemRecord,
    signal: AbortSignal,
    retryMs: readonly number[] = this.integration.unavailableRetryMs ?? [],
  ): Promise<"ready" | "installation" | "unavailable" | "denied" | "attribution"> {
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
  ): Promise<"ready" | "installation" | "denied" | "attribution"> {
    const ready = await this.integration.check(item, signal);
    if (this.integration.authorize && !(await this.integration.authorize(item, signal)))
      return "denied";
    if (!ready) return "installation";
    if (this.integration.attributionReady && !(await this.integration.attributionReady(item)))
      return "attribution";
    return "ready";
  }

  private deny(itemId: string): void {
    immediate(this.db, () => {
      applyLinearCommand(
        this.db,
        { type: "cancel", source: "linear", itemId, requestedAt: this.now() },
        this.now(),
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

  private migrateLegacy(): void {
    const requests = this.db
      .query<
        {
          question_id: string;
          item_id: string;
          phase: "initial" | "publication";
          session_generation: number;
        },
        []
      >(
        "SELECT question_id,item_id,phase,session_generation FROM linear_github_auth WHERE status IN ('pending','expired')",
      )
      .all();
    for (const request of requests)
      immediate(this.db, () => {
        const item = getWorkItem(this.db, request.item_id);
        this.db.run(
          "UPDATE linear_github_auth SET status='revoked',generation=generation+1 WHERE question_id=? AND status IN ('pending','expired')",
          [request.question_id],
        );
        if (
          !item ||
          item.cancelRequested ||
          item.state !== "awaiting_input" ||
          !this.permitted(item) ||
          this.generation(item) !== request.session_generation ||
          getQuestion(this.db, request.question_id)?.status !== "open"
        ) {
          this.cancelObsolete(request.item_id, request.question_id);
          return;
        }
        this.db.run(
          "INSERT INTO github_integration_hold(question_id,item_id,phase,item_version,session_generation,current_run_id,checkpoint,authority) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(question_id) DO NOTHING",
          [
            request.question_id,
            item.id,
            request.phase,
            item.version,
            request.session_generation,
            item.currentRunId,
            JSON.stringify(item.checkpoint),
            this.integration.identity(item),
          ],
        );
        this.db.run(
          "UPDATE outbox SET status='dropped',locked_by=NULL,locked_until=NULL WHERE op='elicitation' AND status IN ('pending','dead') AND json_extract(payload,'$.questionId')=?",
          [request.question_id],
        );
        const question = getQuestion(this.db, request.question_id)!;
        this.notifyAdministrators(item, question.id, question.sessionId);
        enqueueOutboxOnce(this.db, {
          target: "linear",
          op: "activity",
          orderingKey: question.sessionId,
          idempotencyKey: `github-integration:migrated:${question.id}`,
          payload: {
            sessionId: question.sessionId,
            kind: "thought",
            body: "Waiting for a workspace administrator to restore GitHub App access. Personal GitHub sign-in is no longer required.",
          },
          now: this.now(),
        });
      });
  }

  private permitted(item: WorkItemRecord): boolean {
    return this.allowed(item) && (this.integration.current?.(item) ?? true);
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

function waitingMessage(result: "attribution" | "unavailable" | "installation"): string {
  return result === "attribution"
    ? "The GitHub App commit policy could not be verified. Paws will recheck automatically before continuing; personal GitHub credit is optional."
    : result === "unavailable"
      ? "Workspace authorization could not be checked. Paws will retry automatically before continuing; no personal GitHub sign-in is required."
      : "Waiting for a workspace owner or administrator to restore the GitHub App installation and repository access. Your personal GitHub sign-in is not required.";
}
