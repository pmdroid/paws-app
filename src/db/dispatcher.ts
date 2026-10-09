import type { Database } from "bun:sqlite";
import { DEFAULT_POLL_MS, sleep, type Clock } from "../core";
import { claimOutboxHeads, completeOutbox, retryOutbox, type OutboxRow } from "./outbox";

export type OutboxHandler = (message: OutboxRow) => Promise<void> | void;

/**
 * Delivers the head of every ready session at once. A session whose head is
 * in flight, backing off, or dead is left alone, and other sessions still move.
 */
export class OutboxDispatcher {
  private handler: OutboxHandler | null = null;
  private readonly pending = new Set<Promise<void>>();

  constructor(
    readonly db: Database,
    readonly clock: Clock,
    readonly options: {
      workerId?: string;
      pollMs?: number;
      batchSize?: number;
      backoffBaseMs?: number;
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
    const claimed = claimOutboxHeads(this.db, {
      workerId: this.options.workerId ?? "outbox",
      now: this.clock.now(),
      limit: this.options.batchSize ?? 32,
    });
    for (const message of claimed) {
      this.track(this.deliver(message));
    }
    return claimed;
  }

  async idle(): Promise<void> {
    await Promise.all([...this.pending]);
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

  private track(task: Promise<void>): void {
    this.pending.add(task);
    void task.finally(() => {
      this.pending.delete(task);
    });
  }

  private async deliver(message: OutboxRow): Promise<void> {
    const handler = this.handler;
    if (handler === null) return;
    try {
      await handler(message);
      completeOutbox(this.db, message, this.clock.now());
    } catch (error) {
      retryOutbox(this.db, message, error, {
        now: this.clock.now(),
        baseMs: this.options.backoffBaseMs,
      });
    }
  }
}
