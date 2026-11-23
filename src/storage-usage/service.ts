import { randomUUID } from "node:crypto";
import type { PawsPaths } from "../config";
import {
  latestStorageSnapshotsSteps,
  pendingStorageReportSteps,
  runnerHostVersionSteps,
  saveStorageSnapshotSteps,
  seenMemberRunnersSteps,
  storageReportCommandSteps,
  storageRunnersSteps,
  type Db,
  type Q,
  type Steps,
} from "../db";
import { journalCaught } from "../journal";
import {
  RunnerStorageReportSchema,
  STORAGE_REPORT_RUNNER_VERSION,
  runnerReleaseAtLeast,
  type RunnerCommand,
} from "../runner-protocol";
import { readWebhookBody } from "../webhook-body";
import { measureFilesystems, scanStorage, type StorageFilesystems, type StorageScan } from "./scan";

export const SERVER_MACHINE = "server";
const SCAN_LIMIT_MS = 2 * 60 * 1000;
const SCAN_EVERY_MS = 6 * 60 * 60 * 1000;
const FREE_SPACE_EVERY_MS = 60 * 1000;
const REPORT_MS = 10 * 60 * 1000;
const ONLINE_MS = 60 * 1000;

export type StorageSnapshot = StorageScan<string> & {
  id: string;
  machine: string;
  takenAt: number;
};

export type RunnerStorageView = {
  machine: string;
  name: string;
  state: "fresh" | "stale" | "missing" | "unsupported";
  online: boolean;
  reporting: boolean;
  ageMs: number | null;
  snapshot: StorageSnapshot | null;
};

export type StorageUsageView = {
  scanning: boolean;
  live: StorageFilesystems & { checkedAt: number };
  snapshots: StorageSnapshot[];
  runners: RunnerStorageView[];
};

export type StorageRefresh = "started" | "busy" | "unavailable";

export type StorageUsage = {
  start(): void;
  stop(): Promise<void>;
  refresh(): Promise<void> | null;
  refreshMachine(machine: string): Promise<StorageRefresh>;
  read(): Promise<StorageUsageView>;
  fetch(request: Request, runnerId: string): Promise<Response | null>;
};

export type StorageReportRunners = {
  enqueueSteps(q: Q, command: RunnerCommand): Steps<unknown>;
};

export type StorageUsageOptions = {
  paths: PawsPaths;
  store: Db;
  now?: () => number;
  tmp?: string;
  limitMs?: number;
  runners?: () => Promise<StorageReportRunners | undefined>;
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
  const requests = new Set<Promise<StorageRefresh>>();
  const enqueuing = new Set<string>();
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
  const requestReports = async (only?: string): Promise<StorageRefresh> => {
    const runners = await options.runners?.();
    if (!runners || stopped) return "unavailable";
    const at = now();
    const seen = await options.store.run((q) => seenMemberRunnersSteps(q, at - ONLINE_MS));
    for (const runner of seen) {
      if (only !== undefined && runner.id !== only) continue;
      if (enqueuing.has(runner.id)) {
        if (only !== undefined) return "busy";
        continue;
      }
      enqueuing.add(runner.id);
      const outcome = await options.store
        .transaction(function* (q): Steps<StorageRefresh> {
          const version = yield* runnerHostVersionSteps(q, runner.id);
          if (!runnerReleaseAtLeast(version, STORAGE_REPORT_RUNNER_VERSION)) return "unavailable";
          if (yield* pendingStorageReportSteps(q, runner.id, at)) return "busy";
          yield* runners.enqueueSteps(q, {
            id: randomUUID(),
            type: "storage.report",
            runnerId: runner.id,
            workspaceId: runner.workspaceId,
            issuedAt: at,
            expiresAt: at + REPORT_MS,
          });
          return "started";
        })
        .catch((error: unknown) => {
          journalCaught(error, "storage-usage.report", null);
          return "unavailable" as const;
        })
        .finally(() => enqueuing.delete(runner.id));
      if (only !== undefined) return outcome;
    }
    return only === undefined ? "started" : "unavailable";
  };
  const track = (request: Promise<StorageRefresh>) => {
    const tracked = request
      .catch((error: unknown) => {
        journalCaught(error, "storage-usage.reports", null);
        return "unavailable" as const;
      })
      .finally(() => requests.delete(tracked));
    requests.add(tracked);
    return tracked;
  };
  const scanServer = () => {
    if (running || stopped) return null;
    running = scan()
      .catch((error: unknown) => journalCaught(error, "storage-usage.scan", null))
      .finally(() => {
        running = null;
      });
    return running;
  };
  const refresh = () => {
    const scanning = scanServer();
    if (scanning) void track(requestReports());
    return scanning;
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
      await Promise.all(requests);
    },
    refresh,
    refreshMachine(machine) {
      if (machine === SERVER_MACHINE)
        return Promise.resolve(scanServer() === null ? "busy" : "started");
      return track(requestReports(machine));
    },
    async read() {
      const at = now();
      const { rows, runners, pending } = await options.store.run(function* (q) {
        const listed = yield* storageRunnersSteps(q);
        const reporting = new Set<string>();
        for (const runner of listed)
          if (yield* pendingStorageReportSteps(q, runner.id, at)) reporting.add(runner.id);
        return { rows: yield* latestStorageSnapshotsSteps(q), runners: listed, pending: reporting };
      });
      const snapshots: StorageSnapshot[] = rows.map((row) => ({
        id: row.id,
        machine: row.machine,
        takenAt: row.takenAt,
        partial: row.partial,
        filesystems: row.filesystems as StorageFilesystems,
        categories: row.categories as StorageSnapshot["categories"],
      }));
      return {
        scanning: running !== null,
        live: live ?? (live = measure()),
        snapshots,
        runners: runners.map((runner): RunnerStorageView => {
          const snapshot = snapshots.find((entry) => entry.machine === runner.id) ?? null;
          const online = runner.status === "active" && (runner.lastSeenAt ?? 0) > at - ONLINE_MS;
          const supported = runnerReleaseAtLeast(runner.version, STORAGE_REPORT_RUNNER_VERSION);
          const ageMs = snapshot ? Math.max(0, at - snapshot.takenAt) : null;
          return {
            machine: runner.id,
            name: runner.name,
            state:
              ageMs === null
                ? supported
                  ? "missing"
                  : "unsupported"
                : online && supported && ageMs <= SCAN_EVERY_MS + REPORT_MS
                  ? "fresh"
                  : "stale",
            online,
            reporting: pending.has(runner.id),
            ageMs,
            snapshot,
          };
        }),
      };
    },
    async fetch(request, runnerId) {
      if (new URL(request.url).pathname !== "/v1/storage-report") return null;
      if (request.method !== "POST") return Response.json({ error: "Use POST." }, { status: 405 });
      const body = await readWebhookBody(request, 65_536);
      if (body instanceof Response) return body;
      try {
        const report = RunnerStorageReportSchema.parse(JSON.parse(body.toString("utf8")));
        const duplicate = await options.store.transaction(function* (q) {
          const command = yield* storageReportCommandSteps(q, report.commandId, runnerId);
          if (!command || command.expiresAt <= now() || report.takenAt > now())
            throw new Error("Storage report command is unavailable.");
          if (command.answered) return true;
          yield* saveStorageSnapshotSteps(q, {
            id: report.commandId,
            machine: runnerId,
            takenAt: report.takenAt,
            partial: report.partial,
            filesystems: report.filesystems,
            categories: report.categories,
          });
          return false;
        });
        return Response.json({ duplicate });
      } catch (error) {
        journalCaught(error, "storage-usage.fetch", null);
        return Response.json({ error: "Storage report was rejected." }, { status: 403 });
      }
    },
  };
}
