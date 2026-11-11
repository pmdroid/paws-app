import { lastOutboxSequenceSteps, type Q, type Steps } from "../db";

export const HOST_DISK_FULL_THOUGHT =
  "Paused: the Paws host is out of disk space. It retries when space is free.";
const HOUR_MS = 60 * 60_000;

export function* hostDiskFullThoughtKeySteps(
  q: Q,
  itemId: string,
  now: number,
): Steps<string | null> {
  const prefix = `disk-full:${itemId}:`;
  const last = yield* lastOutboxSequenceSteps(q, prefix);
  return last > 0 && now - last < HOUR_MS ? null : `${prefix}${now}`;
}
