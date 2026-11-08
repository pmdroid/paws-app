import { journalCaught, journalItemId } from "../journal";
import type { Database } from "bun:sqlite";
import { DEFAULT_POLL_MS, sleep, type Clock } from "../core";
import { sqliteDb, type Db } from "./db";
import {
  claimOutboxHeadsSteps,
  coalesceOutboxAsync,
  completeOutboxSteps,
  isOutboxCurrent,
  isOutboxCurrentSteps,
  retryOutbox,
  releaseOutboxLeaseSteps,
  type OutboxRow,
} from "./outbox";

export type OutboxDeliveryContext = { signal: AbortSignal; isCurrent(): boolean };
export type OutboxHandler = (
  message: OutboxRow,
  context: OutboxDeliveryContext,
) => Promise<void> | void;

/**
 * Delivers the head of every ready session at once. A session whose head is
 * in flight, backing off, or dead is left alone, and other sessions still move.
 */
export class OutboxDispatcher {
  private handler: OutboxHandler | null = null;
  private readonly pending = new Map<Promise<void>, OutboxRow>();
  private readonly active = new Map<number, { row: OutboxRow; controller: AbortController }>();
  /** The async `Db` for converted code: `sqliteDb(db)` unless startup passes one. */
  readonly store: Db;

  constructor(
    readonly db: Database,
    readonly clock: Clock,
    readonly options: {
      store?: Db;
      workerId?: string;
      claims?: boolean;
      pollMs?: number;
      batchSize?: number;
      backoffBaseMs?: number;
      progressIntervalMs?: number;
    } = {},
  ) {
    this.store = options.store ?? sqliteDb(db);
  }

  get pollMs(): number {
    return this.options.pollMs ?? DEFAULT_POLL_MS;
  }

  setHandler(handler: OutboxHandler): void {
    this.handler = handler;
  }

  async tick(): Promise<OutboxRow[]> {
    if (this.handler === null || this.options.claims === false) return [];
    for (const { row, controller } of [...this.active.values()]) {
      if (!(await this.store.run((q) => isOutboxCurrentSteps(q, row))))
        controller.abort(new Error("Delivery superseded by a session fence."));
    }
    const options = {
      blockedKeys: [...this.active.values()].flatMap(({ row }) =>
        row.orderingKey === null ? [] : [`${row.target}:${row.orderingKey}`],
      ),
      workerId: this.options.workerId ?? "outbox",
      now: this.clock.now(),
      limit: this.options.batchSize ?? 32,
      progressIntervalMs: this.options.progressIntervalMs,
    };
    // The claim is one `UPDATE … RETURNING`, so each claim is its own transaction.
    const claimed = await this.store.run((q) => claimOutboxHeadsSteps(q, options));
    for (const message of claimed) {
      const controller = new AbortController();
      this.active.set(message.id, { row: message, controller });
      this.track(message, this.deliver(message, controller));
    }
    return claimed;
  }

  async idle(match: (row: OutboxRow) => boolean = () => true): Promise<void> {
    await Promise.all([...this.pending].flatMap(([task, row]) => (match(row) ? [task] : [])));
  }

  async run(
    signal: AbortSignal,
    sleeper: (ms: number, signal?: AbortSignal) => Promise<void> = sleep,
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.tick();
      } catch (error) {
        // Same failure as the job loop: one locked database must not end delivery for good.
        journalCaught(error, "dispatcher.run.tick", null);
      }
      if (signal.aborted) break;
      await sleeper(this.pollMs, signal);
    }
    await this.idle();
  }

  private track(row: OutboxRow, task: Promise<void>): void {
    this.pending.set(task, row);
    void task.finally(() => {
      this.pending.delete(task);
    });
  }

  private async deliver(message: OutboxRow, controller: AbortController): Promise<void> {
    const handler = this.handler;
    if (handler === null) return;
    try {
      const claimed = message;
      if (!(await this.store.run((q) => isOutboxCurrentSteps(q, claimed)))) return;
      const options = { now: this.clock.now(), thoughts: Boolean(this.options.progressIntervalMs) };
      message = await coalesceOutboxAsync(this.store, claimed, options);
      const delivered = message;
      await handler(delivered, {
        signal: controller.signal,
        // Handlers ask this synchronously; it stays on the SQLite wrapper until they await it.
        isCurrent: () => isOutboxCurrent(this.db, delivered),
      });
      const now = this.clock.now();
      await this.store.transaction((q) => completeOutboxSteps(q, delivered, now));
    } catch (error) {
      journalCaught(error, "dispatcher.deliver.isOutboxCurrent", journalItemId(message.payload));
      retryOutbox(this.db, message, error, {
        now: this.clock.now(),
        baseMs: this.options.backoffBaseMs,
      });
    } finally {
      const released = message;
      await this.store.run((q) => releaseOutboxLeaseSteps(q, released));
      this.active.delete(message.id);
    }
  }
}
