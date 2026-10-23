import { retryBackoffMs } from "./backoff";

const TRANSIENT_ERROR_NAMES = new Set([
  "LinearRateLimitError",
  "RetryableRunnerError",
  "UsageLimitPause",
  "RunnerWorkFencedError",
  "RunnerUnavailableError",
  "RunnerCapacityWait",
  "PawsShutdown",
  "TimeoutError",
  "GitTransportError",
  "PolicyFetchError",
]);

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const TRANSIENT_GIT =
  /timed? ?out|operation too slow|connection (?:reset|refused|closed)|could not resolve host|temporary failure in name resolution|failed to connect to|remote end hung up unexpectedly|early eof|rpc failed; curl|gnutls|ssl_(?:read|connect|error)|returned error: 5\d\d|\bhttp\/?[\d.]* 5\d\d\b|internal server error|bad gateway|service unavailable|gateway timeout/i;

export function isTransientGitError(stderr: string): boolean {
  return TRANSIENT_GIT.test(stderr);
}

export const MAX_TRANSIENT_RETRIES = 5;
export const TRANSIENT_RETRY_BASE_MS = 30_000;
export const TRANSIENT_RETRY_CAP_MS = 10 * 60_000;
export const RUNNER_CAPACITY_WAIT_MS = 60 * 60_000;
const PLACEMENT_WAIT_POLLS = [20, 60, 120, 240];

export function placementWaitMs(attempt: number, pollIntervalMs = 250) {
  return pollIntervalMs * PLACEMENT_WAIT_POLLS[Math.min(attempt, PLACEMENT_WAIT_POLLS.length - 1)]!;
}

export class RunnerCapacityWait extends Error {
  override readonly name = "RunnerCapacityWait";
  constructor(
    readonly runnerIds: readonly string[],
    readonly holdMs?: number,
  ) {
    super(
      runnerIds.length
        ? `Waiting for a free slot on runner ${runnerIds.join(", ")}`
        : "Waiting for a paired runner to come online",
    );
  }
}

export function isTransientFailure(error: unknown, depth = 0): boolean {
  if (typeof error !== "object" || error === null || depth > 3) return false;
  const { name, code, status, message, cause } = error as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  if (typeof name === "string" && TRANSIENT_ERROR_NAMES.has(name)) return true;
  if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
  if (typeof status === "number" && (status === 429 || status >= 500)) return true;
  if (message === "fetch failed" && cause === undefined) return true;
  return isTransientFailure(cause, depth + 1);
}

export function transientRetryDelayMs(
  retry: number,
  error: unknown,
  baseMs = TRANSIENT_RETRY_BASE_MS,
): number {
  const retryAfter = retryAfterMs(error);
  if (retryAfter !== null) return Math.max(retryAfter, baseMs);
  return retryBackoffMs(retry, baseMs, TRANSIENT_RETRY_CAP_MS);
}

export function retryAfterMs(error: unknown): number | null {
  const retryAfter = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof retryAfter === "number" && Number.isSafeInteger(retryAfter) && retryAfter >= 0
    ? retryAfter
    : null;
}

export function retryNote(message: string, delayMs: number): string {
  const sentence = /[.!?]$/.test(message) ? message : `${message}.`;
  return `${sentence} Paws tries again in ${describeDelay(delayMs)}.`;
}

function describeDelay(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  return `${Math.round(ms / 60_000)} min`;
}
