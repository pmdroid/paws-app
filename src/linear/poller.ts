import type { CatchUpSource } from "./catchup";
import type { AcceptedLinearEvent } from "./events";
import type { InboxStore } from "./inbox";

/** Steady-state catch-up while the tunnel is forwarding webhooks. */
export const POLL_INTERVAL_UP_MS = 60_000;

/** Faster catch-up when ngrok is down or `--no-tunnel` is set. */
export const POLL_INTERVAL_DOWN_MS = 3_000;

/** Wall clock ahead of monotonic time by more than this is a laptop wake. */
export const WAKE_GAP_MS = 30_000;

const CURSOR_NAME = "linear";
const INITIAL_LOOKBACK_MS = 60 * 60 * 1000;
const OVERLAP_MS = 5_000;

export function pollIntervalMs(tunnelUp: boolean): number {
  return tunnelUp ? POLL_INTERVAL_UP_MS : POLL_INTERVAL_DOWN_MS;
}

export function sleepGapMs(input: {
  previousWallMs: number;
  previousMonoMs: number;
  wallMs: number;
  monoMs: number;
}): number {
  return input.wallMs - input.previousWallMs - (input.monoMs - input.previousMonoMs);
}

export type Sleeper = {
  wait(ms: number): Promise<void>;
  wake(): void;
};

export type CatchUpPoller = {
  stop(): void;
  noteWake(): void;
  pollNow(): Promise<void>;
  settled: Promise<void>;
};

export function createTimerSleeper(): Sleeper {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveWait: (() => void) | null = null;
  return {
    wait(ms) {
      return new Promise((resolve) => {
        resolveWait = resolve;
        timer = setTimeout(() => {
          timer = null;
          resolveWait = null;
          resolve();
        }, ms);
        unref(timer);
      });
    },
    wake() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const resolve = resolveWait;
      resolveWait = null;
      resolve?.();
    },
  };
}

/**
 * Catch-up poller. Runs immediately, then every 60s while the tunnel is up
 * and every 3s while it is down. `noteWake` and a wall/mono gap over 30s poll early.
 */
export function startCatchUpPoller(options: {
  source: CatchUpSource;
  store: InboxStore;
  onEvent: (event: AcceptedLinearEvent) => Promise<void> | void;
  tunnelUp: () => boolean;
  beforeDelay?: () => Promise<void>;
  sleeper?: Sleeper;
  now?: () => number;
  mono?: () => number;
}): CatchUpPoller {
  const sleeper = options.sleeper ?? createTimerSleeper();
  const now = options.now ?? Date.now;
  const mono = options.mono ?? (() => performance.now());
  const control = { stopped: false };
  let wakeRequested = false;
  let running = false;
  let pending = false;

  async function pollOnce(): Promise<void> {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      do {
        pending = false;
        await pollBody();
      } while (pending && !control.stopped);
    } finally {
      running = false;
    }
  }

  async function pollBody(): Promise<void> {
    const replay = options.store.listUnhandled();
    for (const event of replay) {
      await options.onEvent(event);
      options.store.markHandled(event.dedupeKey);
    }
    const saved = options.store.getCursor(CURSOR_NAME);
    const since = saved === null ? now() - INITIAL_LOOKBACK_MS : Math.max(0, saved - OVERLAP_MS);
    const events = await options.source.listUpdated(since);
    for (const event of events) {
      const committed = options.store.commit(event);
      if (!committed.inserted && committed.handled) continue;
      await options.onEvent(event);
      options.store.markHandled(event.dedupeKey);
    }
    options.store.setCursor(CURSOR_NAME, now());
  }

  const settled = (async () => {
    while (!control.stopped) {
      try {
        await pollOnce();
      } catch (error) {
        const message = error instanceof Error ? error.message : "catch-up failed";
        console.error(`linear catch-up failed: ${message}`);
      }
      if (control.stopped) return;
      if (wakeRequested) {
        wakeRequested = false;
        continue;
      }
      const previousWallMs = now();
      const previousMonoMs = mono();
      await options.beforeDelay?.();
      if (control.stopped) return;
      await sleeper.wait(pollIntervalMs(options.tunnelUp()));
      if (control.stopped) return;
      const gap = sleepGapMs({
        previousWallMs,
        previousMonoMs,
        wallMs: now(),
        monoMs: mono(),
      });
      if (gap > WAKE_GAP_MS || wakeRequested) wakeRequested = false;
    }
  })();

  return {
    stop() {
      control.stopped = true;
      sleeper.wake();
    },
    noteWake() {
      wakeRequested = true;
      sleeper.wake();
    },
    pollNow: pollOnce,
    settled,
  };
}

function unref(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    const unrefTimer = timer.unref;
    if (typeof unrefTimer === "function") unrefTimer.call(timer);
  }
}
