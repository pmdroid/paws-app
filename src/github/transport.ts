import { GitCommandError, type GitExec } from "./types";

export const GIT_TRANSPORT_RETRY_MS = [5_000, 20_000] as const;

const TRANSIENT_GIT =
  /timed? ?out|operation too slow|connection (?:reset|refused|closed)|could not resolve host|temporary failure in name resolution|failed to connect to|remote end hung up unexpectedly|early eof|rpc failed; curl|gnutls|ssl_(?:read|connect|error)|returned error: 5\d\d|\bhttp\/?[\d.]* 5\d\d\b|internal server error|bad gateway|service unavailable|gateway timeout/i;

export class GitTransportError extends GitCommandError {
  constructor(args: string[], stderr: string) {
    super(args, stderr);
    this.name = "GitTransportError";
  }
}

export function isTransientGitError(stderr: string): boolean {
  return TRANSIENT_GIT.test(stderr);
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
