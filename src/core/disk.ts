import { statfsSync } from "node:fs";
import { HostDiskFullError } from "./failure";

export type StatFs = (path: string) => { bavail: number; blocks: number; bsize: number };

export type DiskSpace = {
  path: string;
  freeBytes: number;
  minFreeBytes: number;
  low: boolean;
};

export function diskSpace(path: string, statfs: StatFs = statfsSync): DiskSpace {
  const stats = statfs(path);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  const minFreeBytes = Math.max(
    1024 ** 3,
    Math.ceil(Number(stats.blocks) * Number(stats.bsize) * 0.05),
  );
  return { path, freeBytes, minFreeBytes, low: freeBytes < minFreeBytes };
}

export function hostDiskFullError(
  paths: readonly string[],
  detail: string,
  cause?: unknown,
  statfs: StatFs = statfsSync,
): HostDiskFullError {
  let fullest: DiskSpace | null = null;
  for (const path of paths) {
    try {
      const space = diskSpace(path, statfs);
      if (fullest === null || space.freeBytes < fullest.freeBytes) fullest = space;
    } catch {
      continue;
    }
  }
  return new HostDiskFullError(
    fullest?.path ?? null,
    fullest?.freeBytes ?? null,
    detail,
    cause === undefined ? undefined : { cause },
  );
}
