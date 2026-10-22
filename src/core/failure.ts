import { retryBackoffMs } from "./backoff";

const TRANSIENT_ERROR_NAMES = new Set([
  "LinearRateLimitError",
  "RetryableRunnerError",
  "UsageLimitPause",
  "RunnerWorkFencedError",
  "RunnerUnavailableError",
  "PawsShutdown",
  "TimeoutError",
  "GitTransportError",
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

export const MAX_TRANSIENT_RETRIES = 5;
export const TRANSIENT_RETRY_BASE_MS = 30_000;
export const TRANSIENT_RETRY_CAP_MS = 10 * 60_000;

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
