/** Raised by seams that exist so later issues can fill them in. */
export class NotImplementedError extends Error {
  constructor(feature: string) {
    super(`${feature} is not implemented`);
    this.name = "NotImplementedError";
  }
}

/**
 * The agent reached its usage limit and no runner with an available account can take the work.
 * `prompt` carries the continuation built from the interrupted conversation, when there was one,
 * and `session` the agent session the runner that hit the limit can continue.
 */
export class UsageLimitError extends Error {
  constructor(
    readonly agent: string,
    readonly resetsAt: number | null,
    readonly runnerId: string | null = null,
    readonly prompt?: string,
    readonly session?: { runnerId: string; sessionId: string },
  ) {
    super(
      `${agent} reached its usage limit${resetsAt === null ? "" : ` until ${new Date(resetsAt).toISOString()}`}`,
    );
    this.name = "UsageLimitError";
  }
}
