import { journalCaught } from "../journal";
import { isTransientGitError } from "../core";
import { GitCommandError, type GitExec } from "./types";

export const GIT_TRANSPORT_RETRY_MS = [5_000, 20_000] as const;

export class GitTransportError extends GitCommandError {
  constructor(args: string[], stderr: string) {
    super(args, stderr);
    this.name = "GitTransportError";
  }
}

/**
 * GitHub refused a push from the App with no reason beyond the refusal: `denied to <app>[bot]`
 * or a bare HTTP 403. Paws treats that as a push outage of the repository (PAS-867), so the
 * pushes wait and a probe retries. A refusal that says why, such as a protected branch, a push
 * rule or the missing `workflows` permission, is not an outage and keeps its own handling.
 */
const PUSH_OUTAGE =
  /\bdenied to [\w.-]+\[bot\]|returned error: 403\b|\bHTTP\/?[\d.]* 403\b|\b403 Forbidden\b/i;
const PUSH_REFUSAL_REASON =
  /protected branch|\bGH0\d\d\b|refusing to allow an? (?:GitHub App|OAuth App|Personal Access Token)|\bworkflows?\b.*\bpermission\b|pre-receive hook declined|push declined|Repository not found/i;

export function isPushOutage(stderr: string): boolean {
  return PUSH_OUTAGE.test(stderr) && !PUSH_REFUSAL_REASON.test(stderr);
}

/** Waits between probe pushes during a push outage: 1, 2 and 5 minutes, then every 10 minutes. */
export const PUSH_OUTAGE_PROBE_MS = [60_000, 120_000, 300_000, 600_000] as const;

export function pushOutageProbeDelayMs(failedProbes: number): number {
  return PUSH_OUTAGE_PROBE_MS[Math.min(Math.max(0, failedProbes), PUSH_OUTAGE_PROBE_MS.length - 1)]!;
}

/**
 * A push GitHub refused during a push outage (see {@link isPushOutage}). `held` means Paws did not
 * try the push because another push probes the outage.
 */
export class PushOutageError extends GitCommandError {
  constructor(
    args: string[],
    stderr: string,
    readonly held = false,
  ) {
    super(args, stderr);
    this.name = "PushOutageError";
  }
}

/** The push outage error in an error's cause chain, or null. */
export function pushOutageCause(error: unknown): PushOutageError | null {
  for (let current = error, depth = 0; current instanceof Error && depth < 4; depth++) {
    if (current instanceof PushOutageError) return current;
    current = current.cause;
  }
  return null;
}

export function hasGitTransportCause(error: unknown): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 4; depth++) {
    if (current instanceof GitTransportError) return true;
    current = current.cause;
  }
  return false;
}

export function retryGitTransport(
  gitExec: GitExec,
  sleep: (ms: number) => Promise<void> = wait,
): GitExec {
  return async (args, options) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await gitExec(args, options);
      } catch (error) {
        if (!(error instanceof GitCommandError) || !isTransientGitError(error.stderr)) throw error;

        const delay = GIT_TRANSPORT_RETRY_MS[attempt];
        if (delay === undefined) throw new GitTransportError(error.args, error.stderr);
        journalCaught(error, "transport.retryGitTransport.gitExec", null);
        options.signal?.throwIfAborted();
        await sleep(delay);
        options.signal?.throwIfAborted();
      }
    }
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
