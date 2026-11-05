import { journalCaught } from "../journal";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  statSync,
} from "node:fs";

export const SETGID = 0o2000;
const SHARED_MODE_MASK = 0o7777 & ~SETGID;

export type SharedDirectoryRule = { owners: readonly number[]; gid: number; mode: number };

export function sharedDirectoryAllowed(
  info: { uid: number; gid: number; mode: number },
  rule: SharedDirectoryRule,
): boolean {
  return (
    rule.owners.includes(info.uid) &&
    info.gid === rule.gid &&
    (info.mode & SHARED_MODE_MASK) === rule.mode
  );
}

export function openSharedDirectory(
  parent: number,
  name: string,
  gid: number,
  mode: number,
): number {
  const path = `/proc/self/fd/${parent}/${name}`;
  try {
    mkdirSync(path, { mode });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    journalCaught(error, "shared.openSharedDirectory.mkdirSync", null, "path may already exist");
  }
  const directory = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const info = fstatSync(directory);
    if (info.gid !== gid) throw new Error("Shared runner directory is not in the shared group");
    if ((info.mode & 0o7777) !== mode) fchmodSync(directory, mode);
    return directory;
  } catch (error) {
    closeSync(directory);
    throw error;
  }
}

export function clearInheritedSetgid(path: string): void {
  const mode = statSync(path).mode & 0o7777;
  if (mode & SETGID) chmodSync(path, mode & ~SETGID);
}
