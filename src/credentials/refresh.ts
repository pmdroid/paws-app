import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { claimNextJob, completeJob, enqueueJobOnce, failJob, getJob } from "../db";

type RotatingCredential = { accessToken: string; refreshToken: string | null };

export async function refreshCredential<T extends RotatingCredential>(input: {
  db: Database;
  identity: string;
  read: () => T | null;
  write: (value: T) => void;
  refresh: (value: T, signal: AbortSignal) => Promise<T>;
  leaseMs?: number;
}): Promise<T> {
  const original = input.read();
  if (original?.refreshToken == null)
    throw new Error("No refresh token is stored. Reconnect the integration.");
  const queue = `oauth.refresh.${digest(input.identity)}.${digest(original.refreshToken)}`;
  const id = enqueueJobOnce(input.db, { queue, jobKey: queue, maxAttempts: 10 });
  const workerId = `oauth:${process.pid}:${randomUUID()}`;
  const leaseMs = input.leaseMs ?? 30_000;
  for (;;) {
    const current = input.read();
    if (current === null) throw new Error("Integration credentials were removed.");
    if (changed(original, current)) return current;
    const state = getJob(input.db, id);
    if (state?.status === "dead" || state?.status === "done" || state?.status === "cancelled") {
      const latest = input.read();
      if (latest !== null && changed(original, latest)) return latest;
      throw new Error("Integration refresh could not complete. Reconnect the integration.");
    }
    const job = claimNextJob(input.db, { workerId, leaseMs, queues: [queue] });
    if (job === null) {
      await Bun.sleep(50);
      continue;
    }
    try {
      const next = await input.refresh(current, AbortSignal.timeout(Math.min(15_000, leaseMs / 2)));
      const held = getJob(input.db, id);
      if (held?.lockedBy !== job.lockedBy || (held.lockedUntil ?? 0) <= Date.now()) continue;
      const latest = input.read();
      if (latest === null) throw new Error("Integration credentials were removed.");
      if (changed(original, latest)) {
        completeJob(input.db, job);
        return latest;
      }
      input.write(next);
      completeJob(input.db, job);
      return next;
    } catch {
      failJob(input.db, job, new Error("Integration token refresh failed."), { baseMs: 100 });
      throw new Error("Integration token refresh failed. Retry or reconnect the integration.");
    }
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function changed(a: RotatingCredential, b: RotatingCredential): boolean {
  return a.accessToken !== b.accessToken || a.refreshToken !== b.refreshToken;
}
