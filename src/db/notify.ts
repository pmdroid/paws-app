import { SQL } from "bun";
import { journalCaught } from "../journal";
import type { Db } from "./db";

type ListenClient = {
  listen(
    channel: string,
    onnotify: (payload?: string) => void,
  ): Promise<(() => Promise<void>) | { unlisten(): Promise<void> }>;
};

const NOTIFY_IDLE_MS = 10_000;

function listenClient(store: Db): ListenClient | null {
  const client = (store.orm as { $client?: Partial<ListenClient> }).$client;
  return typeof client?.listen === "function" ? (client as ListenClient) : null;
}

const RUN_BACKSTOP_MS = 5_000;

type RunWatch = Disposable & {
  wait(ms: number, signal: AbortSignal): Promise<void>;
  wake(): void;
};

export function createRunWaker(store: Db, fallbackMs: number) {
  const watches = new Map<string, Set<{ pending: boolean; resolve?: () => void }>>();
  let stop: (() => Promise<void>) | null = null;
  const nudge = (runId?: string) => {
    for (const [id, set] of watches)
      if (runId === undefined || runId === id)
        for (const watch of set) {
          watch.pending = true;
          watch.resolve?.();
        }
  };
  return {
    backstopMs: listenClient(store) === null ? fallbackMs : RUN_BACKSTOP_MS,
    watch(runId: string): RunWatch {
      const watch: { pending: boolean; resolve?: () => void } = { pending: false };
      const set = watches.get(runId) ?? new Set();
      watches.set(runId, set.add(watch));
      stop ??= listenForNotify(store, "paws_runner_run", nudge, "runner-run.wake", () => nudge());
      return {
        async wait(ms, signal) {
          signal.throwIfAborted();
          if (!watch.pending)
            await new Promise<void>((resolve) => {
              const done = () => {
                clearTimeout(timer);
                signal.removeEventListener("abort", done);
                watch.resolve = undefined;
                resolve();
              };
              const timer = setTimeout(done, ms);
              signal.addEventListener("abort", done, { once: true });
              watch.resolve = done;
            });
          watch.pending = false;
          signal.throwIfAborted();
        },
        wake: () => {
          watch.pending = true;
          watch.resolve?.();
        },
        [Symbol.dispose]() {
          set.delete(watch);
          if (set.size === 0) watches.delete(runId);
          if (watches.size > 0 || stop === null) return;
          void stop();
          stop = null;
        },
      };
    },
  };
}

export function idleBackstopMs(store: Db, fallbackMs: number): number {
  return listenClient(store) === null ? fallbackMs : NOTIFY_IDLE_MS;
}

export function listenForNotify(
  store: Db,
  channel: string,
  wake: (payload?: string) => void,
  site: string,
  subscribed?: () => void,
): () => Promise<void> {
  let unlisten: (() => Promise<void>) | undefined;
  let stopped = false;
  void subscribe(store, channel, wake, site).then((stop) => {
    if (stopped) return stop();
    unlisten = stop;
    subscribed?.();
  });
  return async () => {
    stopped = true;
    await unlisten?.();
  };
}

async function subscribe(
  store: Db,
  channel: string,
  wake: (payload?: string) => void,
  site: string,
): Promise<() => Promise<void>> {
  const client = listenClient(store);
  if (client === null) return async () => {};
  let subscribed = false;
  const relisten = () => {
    if (subscribed) wake(undefined);
    subscribed = true;
  };
  try {
    const handle =
      client instanceof SQL
        ? await client.listen(channel, wake, relisten)
        : await client.listen(channel, wake);
    return async () => {
      try {
        await (typeof handle === "function" ? handle() : handle.unlisten());
      } catch (error) {
        journalCaught(error, `${site}.unlisten`, null);
      }
    };
  } catch (error) {
    journalCaught(error, `${site}.listen`, null);
    return async () => {};
  }
}
