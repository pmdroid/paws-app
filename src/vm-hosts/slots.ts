import type { VmHostSettings } from "../db";

export type VmHostMetrics = {
  cpuCount: number | null;
  memoryTotalBytes: number | null;
  poolBytes?: number | null;
};

export type VmHostSlotReason = "cpu" | "memory" | "disk" | "cap" | "unknown";

export type VmHostSlots = { slots: number; reason: VmHostSlotReason };

const GIB = 1024 ** 3;

const POOL_FREE_SHARE = 0.2;

function vmDiskNeedBytes(size: Pick<VmHostSettings, "vmDiskGb" | "vmMemoryGb">): number {
  return (size.vmDiskGb + size.vmMemoryGb) * GIB;
}

export function vmHostSlots(host: VmHostMetrics, size: VmHostSettings): VmHostSlots {
  if (host.cpuCount === null || host.memoryTotalBytes === null)
    return { slots: 0, reason: "unknown" };
  const cpu = Math.max(0, Math.floor((host.cpuCount - size.reserveVcpus) / size.vmVcpus));
  const memory = Math.max(
    0,
    Math.floor((host.memoryTotalBytes / GIB - size.reserveMemoryGb) / size.vmMemoryGb),
  );
  let fits: VmHostSlots =
    cpu <= memory ? { slots: cpu, reason: "cpu" } : { slots: memory, reason: "memory" };
  if (host.poolBytes !== undefined && host.poolBytes !== null) {
    const disk = Math.floor((host.poolBytes * (1 - POOL_FREE_SHARE)) / vmDiskNeedBytes(size));
    if (disk < fits.slots) fits = { slots: disk, reason: "disk" };
  }
  if (size.slotCap !== null && size.slotCap < fits.slots)
    return { slots: size.slotCap, reason: "cap" };
  return fits;
}
