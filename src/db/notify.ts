import { SQL } from "bun";
import { journalCaught } from "../journal";
import type { Db } from "./db";

type ListenClient = {
  listen(
    channel: string,
    onnotify: (payload: string) => void,
  ): Promise<(() => Promise<void>) | { unlisten(): Promise<void> }>;
};

const NOTIFY_IDLE_MS = 10_000;

function listenClient(store: Db): ListenClient | null {
  const client = (store.orm as { $client?: Partial<ListenClient> }).$client;
  return typeof client?.listen === "function" ? (client as ListenClient) : null;
}

export function idleBackstopMs(store: Db, fallbackMs: number): number {
  return listenClient(store) === null ? fallbackMs : NOTIFY_IDLE_MS;
}

export function listenForNotify(
  store: Db,
  channel: string,
  wake: () => void,
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
  wake: () => void,
  site: string,
): Promise<() => Promise<void>> {
  const client = listenClient(store);
  if (client === null) return async () => {};
  let subscribed = false;
  const relisten = () => {
    if (subscribed) wake();
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
