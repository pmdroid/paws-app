import { and, eq, lte, or, sql } from "drizzle-orm";
import type { Db } from "./db";

export type RepositoryMergeLock = {
  repository: string;
  holder: string;
  itemId: string;
  jobId: number;
  instanceId: string | null;
  acquiredAt: number;
  expiresAt: number;
};

export function repositoryMergeLockKey(owner: string, repo: string): string {
  return `${owner}/${repo}`.toLowerCase();
}

export function acquireRepositoryMergeLock(
  db: Db,
  input: Omit<RepositoryMergeLock, "acquiredAt" | "expiresAt"> & { now: number; ttlMs: number },
): Promise<boolean> {
  return db.run(function* (q) {
    const { repositoryMergeLock: lock } = q.t;
    const row = {
      repository: input.repository,
      holder: input.holder,
      itemId: input.itemId,
      jobId: input.jobId,
      instanceId: input.instanceId,
      acquiredAt: input.now,
      expiresAt: input.now + input.ttlMs,
    };
    const taken = yield* q.all(
      q.orm
        .insert(lock)
        .values(row)
        .onConflictDoUpdate({
          target: lock.repository,
          set: {
            holder: row.holder,
            itemId: row.itemId,
            jobId: row.jobId,
            instanceId: row.instanceId,
            acquiredAt: row.acquiredAt,
            expiresAt: row.expiresAt,
          },
          setWhere: or(lte(lock.expiresAt, input.now), eq(lock.holder, sql`excluded.holder`)),
        })
        .returning({ holder: lock.holder }),
    );
    return taken.length > 0;
  });
}

export function renewRepositoryMergeLock(
  db: Db,
  input: { repository: string; holder: string; now: number; ttlMs: number },
): Promise<boolean> {
  return db.run(function* (q) {
    const { repositoryMergeLock: lock } = q.t;
    const renewed = yield* q.all(
      q.orm
        .update(lock)
        .set({ expiresAt: input.now + input.ttlMs })
        .where(and(eq(lock.repository, input.repository), eq(lock.holder, input.holder)))
        .returning({ holder: lock.holder }),
    );
    return renewed.length > 0;
  });
}

export function releaseRepositoryMergeLock(
  db: Db,
  input: { repository: string; holder: string },
): Promise<void> {
  return db.run(function* (q) {
    const { repositoryMergeLock: lock } = q.t;
    yield* q.exec(
      q.orm
        .delete(lock)
        .where(and(eq(lock.repository, input.repository), eq(lock.holder, input.holder))),
    );
  });
}

export function readRepositoryMergeLock(
  db: Db,
  repository: string,
): Promise<RepositoryMergeLock | null> {
  return db.run(function* (q) {
    const { repositoryMergeLock: lock } = q.t;
    const row = yield* q.one(q.orm.select().from(lock).where(eq(lock.repository, repository)));
    return row ?? null;
  });
}
