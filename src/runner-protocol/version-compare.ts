import type { RunnerVersion } from "./versions";

/** Whether `version` (`major.minor.patch`, anything after it ignored) is at least `minimum`. */
export function runnerVersionAtLeast(version: string, minimum: RunnerVersion): boolean {
  const parts = version
    .match(/^(\d+)\.(\d+)\.(\d+)/)
    ?.slice(1)
    .map(Number);
  if (!parts) return false;
  for (const [index, part] of parts.entries())
    if (part !== minimum[index]) return part > minimum[index]!;
  return true;
}
