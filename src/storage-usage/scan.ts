import { lstatSync, readdirSync, statfsSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import type { PawsPaths } from "../config";
import { RUNNER_STORAGE_CATEGORIES } from "../runner-protocol";

export const STORAGE_CATEGORIES = [
  "transcripts",
  "run_files",
  "closeout",
  "evidence",
  "tasks",
  "repositories",
  "worktrees",
  "secrets",
  "temporary",
  "deploy_dumps",
  "old_backups",
  "other",
] as const;

export type StorageCategory = (typeof STORAGE_CATEGORIES)[number];
export type CategoryUsage = { bytes: number; files: number };

export type FilesystemUsage = {
  mount: string;
  type: string;
  totalBytes: number;
  freeBytes: number;
  inodesTotal?: number;
  inodesFree?: number;
  memory?: true;
};

export type StorageFilesystems = { home: FilesystemUsage | null; tmp: FilesystemUsage | null };

export type StorageScan<C extends string = StorageCategory> = {
  partial: boolean;
  filesystems: StorageFilesystems;
  categories: Partial<Record<C, CategoryUsage>>;
};

export type RunnerStorageCategory = (typeof RUNNER_STORAGE_CATEGORIES)[number];

const FILESYSTEM_TYPES: Record<number, string> = {
  0x01021994: "tmpfs",
  0xef53: "ext4",
  0x58465342: "xfs",
  0x9123683e: "btrfs",
  0x2fc12fc1: "zfs",
  0x794c7630: "overlay",
  0x6969: "nfs",
  0x65735546: "fuse",
  0xf2f52010: "f2fs",
};

const DEPLOY_DUMP = /^pg-backup-predeploy-.*\.dump$/;
const OLD_DATABASE = /^paws\.db\..+/;

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function mountOf(path: string, dev: number): string {
  let mount = path;
  for (let parent = dirname(mount); parent !== mount; parent = dirname(mount)) {
    if (lstatOrNull(parent)?.dev !== dev) break;
    mount = parent;
  }
  return mount;
}

export function filesystemUsage(path: string): FilesystemUsage | null {
  const stats = lstatOrNull(path);
  if (!stats) return null;
  let fs: ReturnType<typeof statfsSync>;
  try {
    fs = statfsSync(path);
  } catch {
    return null;
  }
  const type = FILESYSTEM_TYPES[Number(fs.type)] ?? `0x${Number(fs.type).toString(16)}`;
  return {
    mount: mountOf(path, stats.dev),
    type,
    totalBytes: Number(fs.blocks) * Number(fs.bsize),
    freeBytes: Number(fs.bavail) * Number(fs.bsize),
    ...(Number(fs.files) > 0
      ? { inodesTotal: Number(fs.files), inodesFree: Number(fs.ffree) }
      : {}),
    ...(type === "tmpfs" ? { memory: true as const } : {}),
  };
}

export function measureFilesystems(home: string, tmp = "/tmp"): StorageFilesystems {
  return { home: filesystemUsage(home), tmp: filesystemUsage(tmp) };
}

function matching(dir: string, pattern: RegExp): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => pattern.test(name))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function categoryRoots(paths: PawsPaths): Record<Exclude<StorageCategory, "other">, string[]> {
  const inHome = (pattern: RegExp) => matching(paths.home, pattern);
  return {
    transcripts: [join(paths.home, "runner-transcripts")],
    run_files: [paths.runsDir],
    closeout: [join(paths.home, "closeout")],
    evidence: [paths.evidenceDir],
    tasks: [join(paths.home, "tasks")],
    repositories: [paths.reposDir],
    worktrees: [paths.worktreesDir],
    secrets: [paths.secretsDir],
    temporary: [paths.tmpDir],
    deploy_dumps: inHome(DEPLOY_DUMP),
    old_backups: [join(paths.home, "backups"), ...inHome(OLD_DATABASE)],
  };
}

export type ScanOptions = {
  deadline: number;
  now?: () => number;
  tmp?: string;
  stopped?: () => boolean;
};

const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function directoriesUnder(root: string, parts: string[]): boolean {
  let path = root;
  for (const part of parts) {
    path = join(path, part);
    if (!lstatOrNull(path)?.isDirectory()) return false;
  }
  return true;
}

function runnerRoots(root: string): Record<Exclude<RunnerStorageCategory, "other">, string[]> {
  const executions = join(root, "runtime", "executions.db");
  return {
    repositories: [join(root, "repositories")],
    worker_logs: ["runtime", "health", "retro"].flatMap((name) =>
      directoriesUnder(root, [name, "workers"])
        ? matching(join(root, name, "workers"), /\.log$/)
        : [],
    ),
    executions: directoriesUnder(root, ["runtime"])
      ? [executions, `${executions}-wal`, `${executions}-shm`]
      : [],
    health: [join(root, "health")],
    tool_caches: [".bun", ".nvm", ".claude", ".grok", ".cache"].map((name) => join(root, name)),
  };
}

export function scanStorage(paths: PawsPaths, options: ScanOptions): Promise<StorageScan> {
  return scanCategories(paths.home, STORAGE_CATEGORIES, categoryRoots(paths), options);
}

export function scanRunnerStorage(
  root: string,
  options: ScanOptions,
): Promise<StorageScan<RunnerStorageCategory>> {
  return scanCategories(root, RUNNER_STORAGE_CATEGORIES, runnerRoots(root), options);
}

async function scanCategories<C extends string>(
  top: string,
  order: readonly C[],
  roots: Record<Exclude<C, "other">, string[]>,
  options: ScanOptions,
): Promise<StorageScan<C>> {
  const now = options.now ?? Date.now;
  const filesystems = measureFilesystems(top, options.tmp);
  const categories: StorageScan<C>["categories"] = {};
  const home = lstatOrNull(top);
  if (!home?.isDirectory()) return { partial: false, filesystems, categories };
  const claimed = new Set(Object.values<string[]>(roots).flat());
  const seen = new Set<string>();
  const measure = async (starts: string[], skip: Set<string>): Promise<CategoryUsage | null> => {
    const usage = { bytes: 0, files: 0 };
    const pending = [...starts];
    while (pending.length > 0) {
      if (now() > options.deadline || options.stopped?.()) return null;
      const path = pending.pop()!;
      const stats = lstatOrNull(path);
      if (!stats || stats.dev !== home.dev) continue;
      const inode = `${stats.dev}:${stats.ino}`;
      if (seen.has(inode)) continue;
      seen.add(inode);
      usage.bytes += Number(stats.blocks) * 512;
      if (!stats.isDirectory()) {
        usage.files += 1;
        continue;
      }
      let names: string[];
      try {
        names = readdirSync(path);
      } catch {
        continue;
      }
      for (const name of names) {
        const child = join(path, name);
        if (!skip.has(child)) pending.push(child);
      }
      await yieldTurn();
    }
    return usage;
  };
  for (const category of order) {
    const usage =
      category === "other"
        ? await measure([top], claimed)
        : await measure(roots[category as Exclude<C, "other">], new Set());
    if (!usage) return { partial: true, filesystems, categories };
    categories[category] = usage;
  }
  return { partial: false, filesystems, categories };
}
