import type { Database } from "bun:sqlite";
import { lastOutboxSequence } from "../db";

export const HOST_DISK_FULL_THOUGHT =
  "Paused: the Paws host is out of disk space. It retries when space is free.";
const HOUR_MS = 60 * 60_000;

export function hostDiskFullThoughtKey(db: Database, itemId: string, now: number): string | null {
  const prefix = `disk-full:${itemId}:`;
  const last = lastOutboxSequence(db, prefix);
  return last > 0 && now - last < HOUR_MS ? null : `${prefix}${now}`;
}
