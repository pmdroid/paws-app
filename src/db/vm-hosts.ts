import { and, eq, gt, isNull } from "drizzle-orm";
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

export function* workspaceVmHostsSteps(q: Q, workspaceId: string, now: number) {
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
          eq(runner.status, "active"),
          gt(runner.lastSeenAt, now - 60_000),
        ),
      )
      .orderBy(runner.id),
  );
  return rows as (VmHostMachine & { host: VmHostRow })[];
}
