import { journalCaught, journalItemId } from "../journal";
import { sleep, type Clock } from "../core";
import { type Db } from "./db";
import { type QueueObserver } from "./loop";
import {
  claimOutboxHeadsSteps,
  coalesceOutbox,
  completeOutboxSteps,
  isOutboxCurrentSteps,
  onOutboxReady,
  retryOutbox,
  releaseOutboxLeaseSteps,
  type OutboxRow,
} from "./outbox";

export const OUTBOX_IDLE_CLAIM_MS = 5_000;

export type OutboxDeliveryContext = { signal: AbortSignal; isCurrent(): Promise<boolean> };
export type OutboxHandler = (
  message: OutboxRow,
  context: OutboxDeliveryContext,
) => Promise<void> | void;

function kindOf(row: OutboxRow): string {
  return row.delivery ?? "ordered";
}

/**
 * Delivers the head of every ready session at once. A session whose head is
 * in flight, backing off, or dead is left alone, and other sessions still move.
 */
export class OutboxDispatcher {
  private handler: OutboxHandler | null = null;
  private readonly targets = new Map<string, OutboxHandler>();
  private readonly pending = new Map<Promise<void>, OutboxRow>();
  /** Ticks still claiming. `idle()` waits for them so it covers what they claim. */
  private readonly claiming = new Set<Promise<unknown>>();
  private readonly active = new Map<number, { row: OutboxRow; controller: AbortController }>();
  private readonly wakes = new Set<number>();
  private waker: (() => void) | null = null;
  /** The async `Db` for converted code: `sqliteDb(db)` unless startup passes one. */
  readonly store: Db;

  constructor(
    readonly db: Db,
    readonly clock: Clock,
    readonly options: {
      store?: Db;
      workerId?: string;
      claims?: boolean;
      pollMs?: number;
      batchSize?: number;
      backoffBaseMs?: number;
      progressIntervalMs?: number;
      observe?: QueueObserver;
    } = {},
  ) {
    this.store = options.store ?? db;
  }

  get pollMs(): number {
    return this.options.pollMs ?? OUTBOX_IDLE_CLAIM_MS;
  }

  setHandler(handler: OutboxHandler): void {
    this.handler = handler;
  }

  setTargetHandler(target: string, handler: OutboxHandler): void {
    this.targets.set(target, handler);
  }

  tick(): Promise<OutboxRow[]> {
    const claim = this.claim();
    const settled = claim.catch(() => undefined);
    this.claiming.add(settled);
    void settled.finally(() => this.claiming.delete(settled));
    return claim;
  }

  private async claim(): Promise<OutboxRow[]> {
    if ((this.handler === null && this.targets.size === 0) || this.options.claims === false)
      return [];
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
      const waitedMs = options.now - Math.max(message.createdAt, message.notBefore);
      this.options.observe?.("outbox.wait", { kind: kindOf(message) }, waitedMs);
      const controller = new AbortController();
      this.active.set(message.id, { row: message, controller });
      this.track(message, this.deliver(message, controller));
    }
    return claimed;
  }

  async idle(match: (row: OutboxRow) => boolean = () => true): Promise<void> {
    await Promise.all(this.claiming);
    await Promise.all([...this.pending].flatMap(([task, row]) => (match(row) ? [task] : [])));
  }

  async run(
    signal: AbortSignal,
    sleeper: (ms: number, signal?: AbortSignal) => Promise<void> = sleep,
  ): Promise<void> {
    const stopWake = onOutboxReady((at) => this.wake(at));
    while (!signal.aborted) {
      const now = this.clock.now();
      for (const at of this.wakes) if (at <= now) this.wakes.delete(at);
      try {
        await this.tick();
      } catch (error) {
        // Same failure as the job loop: one locked database must not end delivery for good.
        journalCaught(error, "dispatcher.run.tick", null);
      }
      if (signal.aborted) break;
      await this.pause(signal, sleeper);
    }
    stopWake();
    await this.idle();
  }

  private wake(at: number): void {
    this.wakes.add(at);
    this.waker?.();
  }

  private async pause(
    signal: AbortSignal,
    sleeper: (ms: number, signal?: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const until = this.clock.now() + this.pollMs;
    while (!signal.aborted) {
      const waitMs = Math.min(...this.wakes, until) - this.clock.now();
      if (waitMs <= 0) return;
      const woken = new AbortController();
      this.waker = () => woken.abort();
      await sleeper(waitMs, AbortSignal.any([signal, woken.signal]));
      this.waker = null;
      if (!woken.signal.aborted) return;
    }
  }

  private track(row: OutboxRow, task: Promise<void>): void {
    this.pending.set(task, row);
    void task.finally(() => {
      this.pending.delete(task);
    });
  }

  private async deliver(message: OutboxRow, controller: AbortController): Promise<void> {
    const handler = this.targets.get(message.target) ?? this.handler;
    if (handler === null) return;
    const startedAt = this.clock.now();
    let outcome = "superseded";
    try {
      const claimed = message;
      if (!(await this.store.run((q) => isOutboxCurrentSteps(q, claimed)))) return;
      const options = { now: this.clock.now(), thoughts: Boolean(this.options.progressIntervalMs) };
      message = await coalesceOutbox(this.store, claimed, options);
      const delivered = message;
      await handler(delivered, {
        signal: controller.signal,
        isCurrent: () => this.store.run((q) => isOutboxCurrentSteps(q, delivered)),
      });
      const now = this.clock.now();
      await this.store.transaction((q) => completeOutboxSteps(q, delivered, now));
      outcome = "delivered";
    } catch (error) {
      outcome = "failed";
      journalCaught(error, "dispatcher.deliver.isOutboxCurrent", journalItemId(message.payload));
      await retryOutbox(this.store, message, error, {
        now: this.clock.now(),
        baseMs: this.options.backoffBaseMs,
      });
    } finally {
      const labels = { kind: kindOf(message), outcome };
      this.options.observe?.("outbox.deliver", labels, this.clock.now() - startedAt);
      const released = message;
      await this.store.run((q) => releaseOutboxLeaseSteps(q, released));
      this.active.delete(message.id);
      this.wake(0);
    }
  }
}
