import { randomUUID } from "node:crypto";
import {
  acquireRepositoryMergeLock,
  releaseRepositoryMergeLock,
  renewRepositoryMergeLock,
  repositoryMergeLockKey,
  type Db,
} from "../db";
import { journalCaught } from "../journal";

export const SQUASH_LOCK_TTL_MS = 2 * 60_000;
export const SQUASH_LOCK_POLL_MS = 1_000;
export const SQUASH_LOCK_WAIT_MS = 30_000;
export const SQUASH_LOCK_RETRY_MS = 5_000;

export type SquashLockOwner = { itemId: string; jobId: number; instanceId: string | null };

export type SquashLockClock = { now(): number; sleep(ms: number): Promise<void> };

export class SquashLock {
  readonly holder: string;
  private repository: string | null = null;
  private renewal: ReturnType<typeof setInterval> | null = null;

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
        this.renewal = setInterval(() => void this.renew(), SQUASH_LOCK_TTL_MS / 3);
        this.renewal.unref?.();
        return true;
      }
      if (waited >= SQUASH_LOCK_WAIT_MS || cancelled()) return false;
      await this.clock.sleep(SQUASH_LOCK_POLL_MS);
    }
  }

  async release(): Promise<void> {
    const repository = this.repository;
    if (repository === null) return;
    this.repository = null;
    if (this.renewal !== null) clearInterval(this.renewal);
    this.renewal = null;
    await releaseRepositoryMergeLock(this.store, { repository, holder: this.holder }).catch(
      (error: unknown) => journalCaught(error, "merge.SquashLock.release", this.owner.itemId),
    );
  }

  private async renew(): Promise<void> {
    const repository = this.repository;
    if (repository === null) return;
    await renewRepositoryMergeLock(this.store, {
      repository,
      holder: this.holder,
      now: this.clock.now(),
      ttlMs: SQUASH_LOCK_TTL_MS,
    }).catch((error: unknown) => journalCaught(error, "merge.SquashLock.renew", this.owner.itemId));
  }
}
