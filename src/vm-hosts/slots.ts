import type { VmHostSettings } from "../db";

export type VmHostMetrics = { cpuCount: number | null; memoryTotalBytes: number | null };

export type VmHostSlotReason = "cpu" | "memory" | "cap" | "unknown";

export type VmHostSlots = { slots: number; reason: VmHostSlotReason };

const GIB = 1024 ** 3;

export function vmHostSlots(host: VmHostMetrics, size: VmHostSettings): VmHostSlots {
  if (host.cpuCount === null || host.memoryTotalBytes === null)
    return { slots: 0, reason: "unknown" };
  const cpu = Math.max(0, Math.floor((host.cpuCount - size.reserveVcpus) / size.vmVcpus));
  const memory = Math.max(
    0,
    Math.floor((host.memoryTotalBytes / GIB - size.reserveMemoryGb) / size.vmMemoryGb),
  );
  const fits: VmHostSlots =
    cpu <= memory ? { slots: cpu, reason: "cpu" } : { slots: memory, reason: "memory" };
  if (size.slotCap !== null && size.slotCap < fits.slots)
    return { slots: size.slotCap, reason: "cap" };
  return fits;
}
