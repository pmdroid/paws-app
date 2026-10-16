import type { Database } from "bun:sqlite";
import { listRunners, type RunnerRecord } from "./runners";

export type RunnerHostSample = {
  cpuPercent?: number;
  memoryTotalBytes?: number;
  memoryAvailableBytes?: number;
  load1?: number;
  load5?: number;
  load15?: number;
  diskFreeBytes?: number;
  diskTotalBytes?: number;
  osId?: string;
  osVersion?: string;
  runnerVersion?: string;
};
export type RunnerHostStatusRecord = {
  [K in keyof RunnerHostSample]-?: NonNullable<RunnerHostSample[K]> | null;
} & { reportedAt: number };
export type RunnerOverview = RunnerRecord & {
  host: RunnerHostStatusRecord | null;
  idle: boolean;
};

const columns = `cpu_percent AS cpuPercent,memory_total_bytes AS memoryTotalBytes,
  memory_available_bytes AS memoryAvailableBytes,load_1 AS load1,load_5 AS load5,load_15 AS load15,
  disk_free_bytes AS diskFreeBytes,disk_total_bytes AS diskTotalBytes,os_id AS osId,
  os_version AS osVersion,runner_version AS runnerVersion,reported_at AS reportedAt`;

/** Replaces the runner's latest host sample. Missing fields are stored as null. */
export function putRunnerHostStatus(
  db: Database,
  runnerId: string,
  sample: RunnerHostSample,
  reportedAt: number,
): void {
  db.run(
    `INSERT INTO runner_host_status(runner_id,cpu_percent,memory_total_bytes,memory_available_bytes,
    load_1,load_5,load_15,disk_free_bytes,disk_total_bytes,os_id,os_version,runner_version,reported_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(runner_id) DO UPDATE SET
    cpu_percent=excluded.cpu_percent,memory_total_bytes=excluded.memory_total_bytes,
    memory_available_bytes=excluded.memory_available_bytes,load_1=excluded.load_1,
    load_5=excluded.load_5,load_15=excluded.load_15,disk_free_bytes=excluded.disk_free_bytes,
    disk_total_bytes=excluded.disk_total_bytes,os_id=excluded.os_id,os_version=excluded.os_version,
    runner_version=excluded.runner_version,reported_at=excluded.reported_at`,
    [
      runnerId,
      sample.cpuPercent ?? null,
      sample.memoryTotalBytes ?? null,
      sample.memoryAvailableBytes ?? null,
      sample.load1 ?? null,
      sample.load5 ?? null,
      sample.load15 ?? null,
      sample.diskFreeBytes ?? null,
      sample.diskTotalBytes ?? null,
      sample.osId ?? null,
      sample.osVersion ?? null,
      sample.runnerVersion ?? null,
      reportedAt,
    ],
  );
}

export function getRunnerHostStatus(db: Database, runnerId: string): RunnerHostStatusRecord | null {
  return db
    .query<RunnerHostStatusRecord, [string]>(
      `SELECT ${columns} FROM runner_host_status WHERE runner_id=?`,
    )
    .get(runnerId);
}

/**
 * Runners with their latest host sample. A runner is idle when it has no
 * unended work and no unacknowledged, unexpired command.
 */
export function listRunnerOverview(
  db: Database,
  workspaceId: string,
  now: number,
): RunnerOverview[] {
  const busy = db.query<{ busy: number }, [string, string, number]>(
    `SELECT EXISTS(SELECT 1 FROM runner_work WHERE runner_id=? AND ended_at IS NULL)
    OR EXISTS(SELECT 1 FROM runner_command WHERE runner_id=? AND acknowledged_at IS NULL AND expires_at>?)
    AS busy`,
  );
  return listRunners(db, workspaceId).map((runner) => ({
    ...runner,
    host: getRunnerHostStatus(db, runner.id),
    idle: busy.get(runner.id, runner.id, now)!.busy === 0,
  }));
}
