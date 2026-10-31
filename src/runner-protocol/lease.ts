import { RUNNER_LEASE_GRACE_MS, RUNNER_LEASE_MS } from "./commands";
import type { RunnerVersion } from "./versions";

/** How often a running Paws records that it is alive. */
export const PAWS_ALIVE_INTERVAL_MS = 15_000;

/**
 * A renewal this far after the alive mark still belongs to the outage that mark begins.
 * Two alive intervals cover one late timer tick; the lease length covers the renewal itself.
 */
export const PAWS_ALIVE_LEASE_SKEW_MS = 2 * PAWS_ALIVE_INTERVAL_MS + RUNNER_LEASE_MS;

/** Whether a reported runner release is at least `minimum`. A missing version is not. */
export function runnerReleaseAtLeast(
  version: string | null | undefined,
  minimum: RunnerVersion,
): boolean {
  const parts = version
    ?.match(/^(\d+)\.(\d+)\.(\d+)/)
    ?.slice(1)
    .map(Number);
  if (!parts || parts.length < 3 || parts.some((part) => !Number.isInteger(part))) return false;
  for (const [index, part] of parts.entries())
    if (part !== minimum[index]) return part > minimum[index]!;
  return true;
}

/**
 * The lease deadline after Paws was unreachable. `leaseUntil` is the last renewal both sides
 * agreed (at most one lease past the last heartbeat). `aliveAt` is Paws's alive mark: the runner
 * passes the mark from that heartbeat, and startup passes the mark stored before the outage.
 * Downtime after that mark does not count, up to `budgetMs` and `expiresAt`. A lease already past
 * its grace at `aliveAt` stays given up. A lease renewed more than `skewMs` after `aliveAt` is
 * not evidence of that outage and stays where it is. The same inputs return the same deadline.
 */
export function creditedLeaseUntil(input: {
  leaseUntil: number;
  expiresAt: number;
  aliveAt: number;
  now: number;
  budgetMs: number;
  skewMs: number;
}): number {
  const { leaseUntil, expiresAt, aliveAt, now, budgetMs, skewMs } = input;
  if (now <= aliveAt) return leaseUntil;
  if (leaseUntil <= aliveAt - RUNNER_LEASE_GRACE_MS) return leaseUntil;
  if (leaseUntil > aliveAt + skewMs) return leaseUntil;
  const shift = Math.min(Math.max(0, now - aliveAt), Math.max(0, budgetMs));
  if (shift === 0) return leaseUntil;
  return Math.max(leaseUntil, Math.min(expiresAt, leaseUntil + shift));
}
