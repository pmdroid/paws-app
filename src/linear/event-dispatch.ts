import type { InboxStore } from "./inbox";

const flights = new WeakMap<InboxStore, Set<string>>();

export function flightsFor(store: InboxStore): Set<string> {
  let pending = flights.get(store);
  if (pending === undefined) {
    pending = new Set<string>();
    flights.set(store, pending);
  }
  return pending;
}

export function isPawsStop(body: string | null): boolean {
  return body !== null && /^\/paws\s+stop\b/i.test(body.trim());
}
