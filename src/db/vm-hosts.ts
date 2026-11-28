import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { type Q } from "./db";

export type VmHostSettings = {
  vmVcpus: number;
  vmMemoryGb: number;
  vmDiskGb: number;
  reserveVcpus: number;
  reserveMemoryGb: number;
  slotCap: number | null;
};

export type VmHostRow = VmHostSettings & { runnerId: string; updatedAt: number; updatedBy: string };

export type VmHostMachine = {
  runnerId: string;
  cpuCount: number | null;
  memoryTotalBytes: number | null;
  host: VmHostRow | null;
};

export function* vmHostMachineSteps(q: Q, workspaceId: string, runnerId: string) {
  const { runner, runnerHostStatus: status, vmHost } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        runnerId: runner.id,
        cpuCount: status.cpuCount,
        memoryTotalBytes: status.memoryTotalBytes,
      })
      .from(runner)
      .leftJoin(status, eq(status.runnerId, runner.id))
      .where(and(eq(runner.id, runnerId), eq(runner.workspaceId, workspaceId))),
  );
  if (!row) return null;
  const host = yield* q.one(q.orm.select().from(vmHost).where(eq(vmHost.runnerId, runnerId)));
  return { ...row, host: (host ?? null) as VmHostRow | null } as VmHostMachine;
}

export function* runnerIsVmHostSteps(q: Q, runnerId: string) {
  const { vmHost } = q.t;
  const row = yield* q.one(
    q.orm.select({ runnerId: vmHost.runnerId }).from(vmHost).where(eq(vmHost.runnerId, runnerId)),
  );
  return Boolean(row);
}

export function* saveVmHostSteps(
  q: Q,
  input: VmHostSettings & { runnerId: string; updatedAt: number; updatedBy: string },
) {
  const { runnerId: _runnerId, ...set } = input;
  yield* q.exec(
    q.orm.insert(q.t.vmHost).values(input).onConflictDoUpdate({ target: q.t.vmHost.runnerId, set }),
  );
}

export function* deleteVmHostSteps(q: Q, runnerId: string) {
  const { vmHost } = q.t;
  const removed = yield* q.all(
    q.orm.delete(vmHost).where(eq(vmHost.runnerId, runnerId)).returning({ id: vmHost.runnerId }),
  );
  return removed.length > 0;
}

export function* workspaceVmHostsSteps(q: Q, workspaceId: string, now?: number) {
  const { runner, runnerHostStatus: status, vmHost } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        runnerId: runner.id,
        cpuCount: status.cpuCount,
        memoryTotalBytes: status.memoryTotalBytes,
        host: vmHost,
      })
      .from(vmHost)
      .innerJoin(runner, eq(runner.id, vmHost.runnerId))
      .leftJoin(status, eq(status.runnerId, runner.id))
      .where(
        and(
          eq(runner.workspaceId, workspaceId),
          isNull(runner.revokedAt),
          now === undefined ? undefined : eq(runner.status, "active"),
          now === undefined ? undefined : gt(runner.lastSeenAt, now - 60_000),
        ),
      )
      .orderBy(runner.id),
  );
  return rows as (VmHostMachine & { host: VmHostRow })[];
}

export function* recordVmHostDisksSteps(
  q: Q,
  input: { runnerId: string; disks: string[]; reportedAt: number },
) {
  const { vmHostDiskReport: report } = q.t;
  const { runnerId: _runnerId, ...set } = input;
  yield* q.exec(
    q.orm
      .insert(report)
      .values(input)
      .onConflictDoUpdate({
        target: report.runnerId,
        set,
        setWhere: lt(report.reportedAt, input.reportedAt),
      }),
  );
}

export function* vmHostDisksSteps(q: Q, runnerId: string) {
  const { vmHostDiskReport: report } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ disks: report.disks, reportedAt: report.reportedAt })
      .from(report)
      .where(eq(report.runnerId, runnerId)),
  );
  return row ?? null;
}
