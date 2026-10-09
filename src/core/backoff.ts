export const DEFAULT_BACKOFF_BASE_MS = 1_000;
export const DEFAULT_BACKOFF_CAP_MS = 60_000;
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_LEASE_MS = 30_000;
export const DEFAULT_POLL_MS = 250;

/** Attempt is 1-based (the value stored after a claim). */
export function retryBackoffMs(
  attempt: number,
  baseMs = DEFAULT_BACKOFF_BASE_MS,
  capMs = DEFAULT_BACKOFF_CAP_MS,
): number {
  const exponent = Math.min(20, Math.max(0, attempt - 1));
  return Math.min(capMs, baseMs * 2 ** exponent);
}
