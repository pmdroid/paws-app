import type { Database } from "bun:sqlite";
import { DEFAULT_POLL_MS, sleep, type Clock } from "../core";
import {
  claimOutboxHeads,
  coalesceOutbox,
  completeOutbox,
  isOutboxCurrent,
  retryOutbox,
  releaseOutboxLease,
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

  constructor(
    readonly db: Database,
    readonly clock: Clock,
    readonly options: {
      workerId?: string;
      pollMs?: number;
      batchSize?: number;
      backoffBaseMs?: number;
      progressIntervalMs?: number;
    } = {},
  ) {}

  get pollMs(): number {
    return this.options.pollMs ?? DEFAULT_POLL_MS;
  }

  setHandler(handler: OutboxHandler): void {
    this.handler = handler;
  }

  tick(): OutboxRow[] {
    if (this.handler === null) return [];
    for (const { row, controller } of this.active.values()) {
      if (!isOutboxCurrent(this.db, row))
        controller.abort(new Error("Delivery superseded by a session fence."));
    }
    const claimed = claimOutboxHeads(this.db, {
      blockedKeys: [...this.active.values()].flatMap(({ row }) =>
        row.orderingKey === null ? [] : [`${row.target}:${row.orderingKey}`],
      ),
      workerId: this.options.workerId ?? "outbox",
      now: this.clock.now(),
      limit: this.options.batchSize ?? 32,
      progressIntervalMs: this.options.progressIntervalMs,
    });
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
      this.tick();
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
      if (!isOutboxCurrent(this.db, message)) return;
      message = coalesceOutbox(this.db, message, {
        now: this.clock.now(),
        thoughts: Boolean(this.options.progressIntervalMs),
      });
      await handler(message, {
        signal: controller.signal,
        isCurrent: () => isOutboxCurrent(this.db, message),
      });
      completeOutbox(this.db, message, this.clock.now());
    } catch (error) {
      retryOutbox(this.db, message, error, {
        now: this.clock.now(),
        baseMs: this.options.backoffBaseMs,
      });
    } finally {
      releaseOutboxLease(this.db, message);
      this.active.delete(message.id);
    }
  }
}
