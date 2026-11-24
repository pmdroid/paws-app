import { isProvisioningError, ProvisioningError, type BootstrapClock } from "../provisioning";

export type StartQueueOptions = {
  startsPerMinute: number;
  maxWaitMs?: number;
  fallbackRetryMs?: number;
  clock?: BootstrapClock;
};

export type StartQueue = {
  start<T>(key: string, run: () => Promise<T>): Promise<T>;
};

type Lane = { tail: Promise<unknown>; starts: number[]; until: number };

const MINUTE = 60_000;

const SYSTEM_CLOCK: BootstrapClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function retryable(error: unknown): error is ProvisioningError {
  return (
    isProvisioningError(error) &&
    (error.code === "rate_limited" || error.status === 503 || error.retryAfterMs !== null)
  );
}

export function createStartQueue(options: StartQueueOptions): StartQueue {
  const clock = options.clock ?? SYSTEM_CLOCK;
  const maxWaitMs = options.maxWaitMs ?? 600_000;
  const fallbackRetryMs = options.fallbackRetryMs ?? 5_000;
  const lanes = new Map<string, Lane>();

  function lane(key: string): Lane {
    const found = lanes.get(key);
    if (found !== undefined) return found;
    const created: Lane = { tail: Promise.resolve(), starts: [], until: 0 };
    lanes.set(key, created);
    return created;
  }

  async function attempt<T>(
    current: Lane,
    run: () => Promise<T>,
    deadline: number,
    cause: { last: ProvisioningError | null },
  ): Promise<T> {
    for (;;) {
      const now = clock.now();
      current.starts = current.starts.filter((at) => at > now - MINUTE);
      const oldest = current.starts[0];
      const full =
        current.starts.length >= options.startsPerMinute && oldest !== undefined
          ? oldest + MINUTE - now
          : 0;
      const wait = Math.max(current.until - now, full);
      if (wait > 0) {
        if (now + wait > deadline)
          throw new ProvisioningError(
            cause.last?.operation ?? "createVm",
            "rate_limited",
            `The provider's start limit would hold this start longer than ${Math.round(maxWaitMs / 1000)} s.`,
            cause.last?.status ?? null,
            cause.last?.detail ?? null,
            wait,
          );
        await clock.sleep(wait);
        continue;
      }
      const at = clock.now();
      current.starts.push(at);
      try {
        return await run();
      } catch (error) {
        if (!retryable(error)) throw error;
        const index = current.starts.indexOf(at);
        if (index >= 0) current.starts.splice(index, 1);
        const delay = Math.max(1_000, error.retryAfterMs ?? fallbackRetryMs);
        current.until = Math.max(current.until, clock.now() + delay);
        cause.last = error;
      }
    }
  }

  return {
    start(key, run) {
      const current = lane(key);
      const deadline = clock.now() + maxWaitMs;
      const result = current.tail.then(() => attempt(current, run, deadline, { last: null }));
      current.tail = result.catch(() => undefined);
      return result;
    },
  };
}
