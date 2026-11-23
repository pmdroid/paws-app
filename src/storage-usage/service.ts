import type { PawsPaths } from "../config";
import { latestStorageSnapshotsSteps, saveStorageSnapshotSteps, type Db } from "../db";
import { journalCaught } from "../journal";
import { measureFilesystems, scanStorage, type StorageFilesystems, type StorageScan } from "./scan";

export const SERVER_MACHINE = "server";
const SCAN_LIMIT_MS = 2 * 60 * 1000;
const SCAN_EVERY_MS = 6 * 60 * 60 * 1000;
const FREE_SPACE_EVERY_MS = 60 * 1000;

export type StorageSnapshot = StorageScan & { id: string; machine: string; takenAt: number };

export type StorageUsageView = {
  scanning: boolean;
  live: StorageFilesystems & { checkedAt: number };
  snapshots: StorageSnapshot[];
};

export type StorageUsage = {
  start(): void;
  stop(): Promise<void>;
  refresh(): Promise<void> | null;
  read(): Promise<StorageUsageView>;
};

export type StorageUsageOptions = {
  paths: PawsPaths;
  store: Db;
  now?: () => number;
  tmp?: string;
  limitMs?: number;
};

export function createStorageUsage(options: StorageUsageOptions): StorageUsage {
  const now = options.now ?? Date.now;
  const measure = () => ({
    ...measureFilesystems(options.paths.home, options.tmp),
    checkedAt: now(),
  });
  let live: StorageUsageView["live"] | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;
  const timers: ReturnType<typeof setInterval>[] = [];
  const scan = async () => {
    const takenAt = now();
    const result = await scanStorage(options.paths, {
      deadline: takenAt + (options.limitMs ?? SCAN_LIMIT_MS),
      now,
      stopped: () => stopped,
      ...(options.tmp === undefined ? {} : { tmp: options.tmp }),
    });
    if (stopped) return;
    live = { ...result.filesystems, checkedAt: now() };
    await options.store.run((q) =>
      saveStorageSnapshotSteps(q, { machine: SERVER_MACHINE, takenAt, ...result }),
    );
  };
  const refresh = () => {
    if (running || stopped) return null;
    running = scan()
      .catch((error: unknown) => journalCaught(error, "storage-usage.scan", null))
      .finally(() => {
        running = null;
      });
    return running;
  };
  const check = () => {
    try {
      live = measure();
    } catch (error) {
      journalCaught(error, "storage-usage.filesystems", null);
    }
  };
  return {
    start() {
      check();
      void refresh();
      timers.push(
        setInterval(check, FREE_SPACE_EVERY_MS),
        setInterval(() => void refresh(), SCAN_EVERY_MS),
      );
      for (const timer of timers) timer.unref?.();
    },
    async stop() {
      stopped = true;
      for (const timer of timers.splice(0)) clearInterval(timer);
      await running;
    },
    refresh,
    async read() {
      const rows = await options.store.run(latestStorageSnapshotsSteps);
      return {
        scanning: running !== null,
        live: live ?? (live = measure()),
        snapshots: rows.map((row) => ({
          id: row.id,
          machine: row.machine,
          takenAt: row.takenAt,
          partial: row.partial,
          filesystems: row.filesystems as StorageFilesystems,
          categories: row.categories as StorageScan["categories"],
        })),
      };
    },
  };
}
