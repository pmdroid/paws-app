import { availableParallelism, cpus, totalmem } from "node:os";

export type HostResources = { cpus: number; memoryGiB: number };

export function hostSlots(host: HostResources): number {
  const bySize = Math.min(Math.floor(host.cpus / 2), Math.floor(host.memoryGiB / 4));
  return Math.min(16, Math.max(1, bySize));
}

export function hostResources(): HostResources {
  return {
    cpus: typeof availableParallelism === "function" ? availableParallelism() : cpus().length,
    memoryGiB: Math.floor(totalmem() / 1024 ** 3),
  };
}

export function runnerConcurrency(
  configured: number | undefined,
  host: () => HostResources,
  log: (line: string) => void,
): number {
  if (configured !== undefined) return configured;
  const resources = host();
  const slots = hostSlots(resources);
  log(`runner slots ${slots} from ${resources.cpus} CPUs and ${resources.memoryGiB} GiB`);
  return slots;
}
