import { expect, test } from "bun:test";
import {
  acquireRepositoryMergeLock,
  readRepositoryMergeLock,
  releaseRepositoryMergeLock,
  renewRepositoryMergeLock,
  repositoryMergeLockKey,
} from "../src/db";
import { forEachDialect } from "./dialects";

const TTL = 60_000;

function lane(holder: string, repository = "acme/app", now = 1_000) {
  return {
    repository,
    holder,
    itemId: `item-${holder}`,
    jobId: holder.length,
    instanceId: `instance-${holder}`,
    now,
    ttlMs: TTL,
  };
}

test("the lock key is the repository's owner/repo, lowercased", () => {
  expect(repositoryMergeLockKey("Acme", "App")).toBe("acme/app");
});

forEachDialect((open) => {
  test("a second holder waits for the first to release", async () => {
    const { db, close } = await open();
    try {
      expect(await acquireRepositoryMergeLock(db, lane("a"))).toBe(true);
      expect(await acquireRepositoryMergeLock(db, lane("b", "acme/app", 2_000))).toBe(false);
      await releaseRepositoryMergeLock(db, { repository: "acme/app", holder: "b" });
      expect(await readRepositoryMergeLock(db, "acme/app")).toEqual({
        repository: "acme/app",
        holder: "a",
        itemId: "item-a",
        jobId: 1,
        instanceId: "instance-a",
        acquiredAt: 1_000,
        expiresAt: 1_000 + TTL,
      });
      await releaseRepositoryMergeLock(db, { repository: "acme/app", holder: "a" });
      expect(await readRepositoryMergeLock(db, "acme/app")).toBeNull();
      expect(await acquireRepositoryMergeLock(db, lane("b", "acme/app", 3_000))).toBe(true);
      expect((await readRepositoryMergeLock(db, "acme/app"))?.holder).toBe("b");
    } finally {
      await close();
    }
  });

  test("a lock past its expiry is taken over, and its old holder cannot renew or release it", async () => {
    const { db, close } = await open();
    try {
      expect(await acquireRepositoryMergeLock(db, lane("a"))).toBe(true);
      expect(await renewRepositoryMergeLock(db, { ...lane("a"), now: 30_000 })).toBe(true);
      expect((await readRepositoryMergeLock(db, "acme/app"))?.expiresAt).toBe(30_000 + TTL);
      expect(await acquireRepositoryMergeLock(db, lane("b", "acme/app", 30_000 + TTL - 1))).toBe(
        false,
      );
      expect(await acquireRepositoryMergeLock(db, lane("b", "acme/app", 30_000 + TTL))).toBe(true);
      expect(await renewRepositoryMergeLock(db, { ...lane("a"), now: 100_000 })).toBe(false);
      await releaseRepositoryMergeLock(db, { repository: "acme/app", holder: "a" });
      expect(await readRepositoryMergeLock(db, "acme/app")).toMatchObject({
        holder: "b",
        acquiredAt: 30_000 + TTL,
        expiresAt: 30_000 + 2 * TTL,
      });
    } finally {
      await close();
    }
  });

  test("the holder taking its own lock again renews it", async () => {
    const { db, close } = await open();
    try {
      expect(await acquireRepositoryMergeLock(db, lane("a"))).toBe(true);
      expect(await acquireRepositoryMergeLock(db, lane("a", "acme/app", 5_000))).toBe(true);
      expect((await readRepositoryMergeLock(db, "acme/app"))?.expiresAt).toBe(5_000 + TTL);
    } finally {
      await close();
    }
  });

  test("different repositories do not block each other", async () => {
    const { db, close } = await open();
    try {
      expect(await acquireRepositoryMergeLock(db, lane("a", "acme/app"))).toBe(true);
      expect(await acquireRepositoryMergeLock(db, lane("b", "acme/api"))).toBe(true);
      expect(await acquireRepositoryMergeLock(db, lane("c", "other/app"))).toBe(true);
      expect((await readRepositoryMergeLock(db, "acme/api"))?.holder).toBe("b");
    } finally {
      await close();
    }
  });
});
