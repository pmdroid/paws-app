import { journalCaught } from "../journal";
import type { RunnerCommand, RunnerStorageReport } from "../runner-protocol";
import { scanRunnerStorage } from "./scan";

const REPORT_LIMIT_MS = 2 * 60 * 1000;

export type RunnerStorageDaemon = {
  pendingCommands(): RunnerCommand[];
  acknowledgeCommand(id: string): Promise<void>;
  postStorageReport(report: RunnerStorageReport): Promise<unknown>;
};

export function createRunnerStorageReporter(options: {
  root: string;
  daemon: RunnerStorageDaemon;
  now?: () => number;
  tmp?: string;
  limitMs?: number;
}) {
  const now = options.now ?? Date.now;
  let running: { id: string; done: Promise<void> } | undefined;
  let stopped = false;
  const report = async (command: RunnerCommand) => {
    const takenAt = now();
    const scan = await scanRunnerStorage(options.root, {
      deadline: takenAt + (options.limitMs ?? REPORT_LIMIT_MS),
      now,
      stopped: () => stopped,
      ...(options.tmp === undefined ? {} : { tmp: options.tmp }),
    });
    if (stopped) return;
    await options.daemon.postStorageReport({ commandId: command.id, takenAt, ...scan });
    await options.daemon.acknowledgeCommand(command.id);
  };
  return {
    async tick() {
      for (const command of options.daemon.pendingCommands()) {
        if (command.type !== "storage.report" || command.id === running?.id) continue;
        if (running || command.expiresAt <= now() || stopped) {
          await options.daemon.acknowledgeCommand(command.id);
          continue;
        }
        const current = {
          id: command.id,
          done: report(command)
            .catch((error: unknown) => journalCaught(error, "storage-usage.runner.report", null))
            .finally(() => {
              if (running === current) running = undefined;
            }),
        };
        running = current;
      }
    },
    running: () => running?.done ?? null,
    async stop() {
      stopped = true;
      await running?.done;
    },
  };
}

export type RunnerStorageReporter = ReturnType<typeof createRunnerStorageReporter>;
