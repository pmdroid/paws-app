import { RunnerWorkFencedError } from "./control";

/**
 * Whether a runner request failed because Paws could not answer it now: a busy or failing
 * database, a body that timed out, or a request aborted while it waited.
 */
export function runnerRequestUnavailable(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/**
 * The status a runner channel answers a failed request with. Fenced work is 409, Paws being
 * unavailable is 503 so the runner retries, and every other refusal stays 403. Runners treat 403
 * and 409 as final, and older runners drop newer heartbeat fields when one is refused with 403.
 */
export function runnerFailureStatus(error: unknown): 403 | 409 | 503 {
  if (error instanceof RunnerWorkFencedError) return 409;
  return runnerRequestUnavailable(error) ? 503 : 403;
}
