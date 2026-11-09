import { randomUUID } from "node:crypto";
import {
  acquireRepositoryMergeLock,
  getConfirmedRemoteMergeSteps,
  holdRepositoryMergeLocksForItem,
  mergeCallInFlightSteps,
  releaseRepositoryMergeLock,
  releaseRepositoryMergeLocksForItem,
  renewRepositoryMergeLock,
  repositoryMergeLockKey,
  type Db,
} from "../db";
import { journalCaught } from "../journal";

export const SQUASH_LOCK_TTL_MS = 2 * 60_000;
export const SQUASH_LOCK_OUTCOME_TTL_MS = 10 * 60_000;
export const SQUASH_LOCK_POLL_MS = 1_000;
export const SQUASH_LOCK_WAIT_MS = 30_000;
export const SQUASH_LOCK_RETRY_MS = 5_000;

export type SquashLockOwner = { itemId: string; jobId: number; instanceId: string | null };

export type SquashLockClock = { now(): number; sleep(ms: number): Promise<void> };

export class SquashLock {
  readonly holder: string;
  private repository: string | null = null;
  private renewal: ReturnType<typeof setInterval> | null = null;
  private lostHold = false;

  constructor(
    private readonly store: Db,
    private readonly owner: SquashLockOwner,
    private readonly clock: SquashLockClock,
  ) {
    this.holder = `${owner.instanceId ?? "paws"}:job-${owner.jobId}:${randomUUID()}`;
  }

  async acquire(owner: string, repo: string, cancelled: () => boolean): Promise<boolean> {
    const repository = repositoryMergeLockKey(owner, repo);
    for (let waited = 0; ; waited += SQUASH_LOCK_POLL_MS) {
      const taken = await acquireRepositoryMergeLock(this.store, {
        repository,
        holder: this.holder,
        ...this.owner,
        now: this.clock.now(),
        ttlMs: SQUASH_LOCK_TTL_MS,
      });
      if (taken) {
        this.repository = repository;
        this.lostHold = false;
        this.renewal = setInterval(() => void this.renew(), SQUASH_LOCK_TTL_MS / 3);
        this.renewal.unref?.();
        return true;
      }
      if (waited >= SQUASH_LOCK_WAIT_MS || cancelled()) return false;
      await this.clock.sleep(SQUASH_LOCK_POLL_MS);
    }
  }

  async confirm(): Promise<boolean> {
    if (this.repository === null || this.lostHold) return false;
    return this.renew();
  }

  async release(): Promise<void> {
    const repository = this.repository;
    if (repository === null) return;
    this.stopRenewal();
    await releaseRepositoryMergeLock(this.store, { repository, holder: this.holder }).catch(
      (error: unknown) => journalCaught(error, "merge.SquashLock.release", this.owner.itemId),
    );
  }

  async finish(): Promise<void> {
    this.stopRenewal();
    const { itemId } = this.owner;
    try {
      const pending = await this.store.run(function* (q) {
        if (!(yield* mergeCallInFlightSteps(q, itemId))) return false;
        return (yield* getConfirmedRemoteMergeSteps(q, itemId)) === null;
      });
      if (pending)
        await holdRepositoryMergeLocksForItem(this.store, {
          itemId,
          now: this.clock.now(),
          ttlMs: SQUASH_LOCK_OUTCOME_TTL_MS,
        });
      else await releaseRepositoryMergeLocksForItem(this.store, itemId);
    } catch (error) {
      journalCaught(error, "merge.SquashLock.finish", itemId);
    }
  }

  private stopRenewal(): void {
    this.repository = null;
    if (this.renewal !== null) clearInterval(this.renewal);
    this.renewal = null;
  }

  private async renew(): Promise<boolean> {
    const repository = this.repository;
    if (repository === null) return false;
    const renewed = await renewRepositoryMergeLock(this.store, {
      repository,
      holder: this.holder,
      now: this.clock.now(),
      ttlMs: SQUASH_LOCK_TTL_MS,
    }).catch((error: unknown) => {
      journalCaught(error, "merge.SquashLock.renew", this.owner.itemId);
      return false;
    });
    if (!renewed && this.repository === repository) this.lostHold = true;
    return renewed;
  }
}
