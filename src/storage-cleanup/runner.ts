import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { journalCaught } from "../journal";
import {
  RunnerStorageCleanupResultSchema,
  STORAGE_CLEANUP_ITEM_LIMIT,
  type RunnerCommand,
  type RunnerStorageCleanupResult,
} from "../runner-protocol";

const DAY = 86_400_000;
const UNKNOWN_MS = 30 * DAY;
const RESULTS_KEPT = 100;
const LOG = /^[0-7][0-9A-HJKMNP-TV-Z]{25}\.log$/;

export type RunnerWorkerLogs = {
  root: string;
  finished(executionId: string): boolean | undefined;
};

export type RunnerCleanupDaemon = {
  pendingCommands(): RunnerCommand[];
  acknowledgeCommand(id: string): Promise<void>;
  postStorageCleanup(result: RunnerStorageCleanupResult): Promise<unknown>;
};

type CleanupCommand = Extract<RunnerCommand, { type: "storage.cleanup" }>;
type Found = { ref: string; path: string; bytes: number } | { ref: string; reason: string };

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

export function createRunnerStorageCleaner(options: {
  root: string;
  daemon: RunnerCleanupDaemon;
  workers: () => readonly RunnerWorkerLogs[];
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const results = join(options.root, "storage-cleanups");

  const examine = (ref: string, olderThanDays: number, at: number): Found => {
    if (!LOG.test(ref)) return { ref, reason: "not an execution log name" };
    for (const workers of options.workers()) {
      if (!lstatOrNull(workers.root)?.isDirectory()) continue;
      const path = join(workers.root, ref);
      const stats = lstatOrNull(path);
      if (!stats) continue;
      if (!stats.isFile()) return { ref, reason: "not a file" };
      const finished = workers.finished(ref.slice(0, -4));
      const age = at - stats.mtimeMs;
      if (finished === false) return { ref, reason: "execution is running" };
      if (age < olderThanDays * DAY) return { ref, reason: `newer than ${olderThanDays} days` };
      if (finished === undefined && age < UNKNOWN_MS)
        return { ref, reason: "unknown execution, newer than 30 days" };
      return { ref, path, bytes: Number(stats.blocks) * 512 };
    }
    return { ref, reason: "already gone" };
  };

  const preview = (command: CleanupCommand, at: number): RunnerStorageCleanupResult => {
    const items: { ref: string; bytes: number }[] = [];
    const kept = new Map<string, number>();
    for (const workers of options.workers()) {
      let names: string[];
      try {
        names = readdirSync(workers.root).filter((name) => name.endsWith(".log"));
      } catch {
        continue;
      }
      for (const name of names) {
        const found = examine(name, command.olderThanDays, at);
        const reason =
          "reason" in found
            ? found.reason
            : items.length >= STORAGE_CLEANUP_ITEM_LIMIT
              ? "over the preview limit"
              : null;
        if (reason === null)
          items.push({ ref: found.ref, bytes: (found as { bytes: number }).bytes });
        else kept.set(reason, (kept.get(reason) ?? 0) + 1);
      }
    }
    return {
      cleanupId: command.cleanupId,
      mode: "preview",
      items,
      kept: [...kept].map(([reason, count]) => ({ reason, count })),
    };
  };

  const run = (command: CleanupCommand, at: number): RunnerStorageCleanupResult => {
    const deleted: { ref: string; bytes: number }[] = [];
    const skipped: { ref: string; reason: string }[] = [];
    for (const ref of new Set(command.items ?? [])) {
      const found = examine(ref, command.olderThanDays, at);
      if ("reason" in found) {
        skipped.push({ ref: ref.slice(0, 128), reason: found.reason });
        continue;
      }
      try {
        unlinkSync(found.path);
        deleted.push({ ref, bytes: found.bytes });
      } catch (error) {
        skipped.push({
          ref,
          reason: error instanceof Error ? error.message.slice(0, 256) : "failed",
        });
      }
    }
    const freedBytes = deleted.reduce((sum, item) => sum + item.bytes, 0);
    return { cleanupId: command.cleanupId, mode: "run", deleted, skipped, freedBytes };
  };

  const stored = (cleanupId: string): RunnerStorageCleanupResult | undefined => {
    try {
      return RunnerStorageCleanupResultSchema.parse(
        JSON.parse(readFileSync(join(results, `${cleanupId}.json`), "utf8")),
      );
    } catch {
      return undefined;
    }
  };

  const store = (result: RunnerStorageCleanupResult) => {
    mkdirSync(results, { recursive: true, mode: 0o700 });
    const path = join(results, `${result.cleanupId}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(result), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    const names = readdirSync(results).sort();
    for (const name of names.slice(0, Math.max(0, names.length - RESULTS_KEPT)))
      rmSync(join(results, name), { force: true });
  };

  const cleanup = (command: CleanupCommand): RunnerStorageCleanupResult => {
    const earlier = stored(command.cleanupId);
    if (earlier?.mode === command.mode) return earlier;
    const at = now();
    const result = command.mode === "preview" ? preview(command, at) : run(command, at);
    store(result);
    return result;
  };

  return {
    cleanup,
    async tick() {
      for (const command of options.daemon.pendingCommands()) {
        if (command.type !== "storage.cleanup") continue;
        try {
          if (command.expiresAt > now()) await options.daemon.postStorageCleanup(cleanup(command));
          await options.daemon.acknowledgeCommand(command.id);
        } catch (error) {
          journalCaught(error, "storage-cleanup.runner.tick", null);
        }
      }
    },
  };
}

export type RunnerStorageCleaner = ReturnType<typeof createRunnerStorageCleaner>;
