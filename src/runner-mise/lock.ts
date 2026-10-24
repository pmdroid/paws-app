import { dlopen, FFIType } from "bun:ffi";
import { closeSync, openSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

type Flock = (fd: number, operation: number) => number;

let flockFn: Flock | null = null;

/** Raised when another holder keeps the lock past the wait limit. */
export class LockWaitTimeoutError extends Error {}

/**
 * Hold an exclusive `flock` on `path` while `body` runs. Other holders of the same file,
 * in this process or another one, wait their turn. `onWait` runs once when the lock is busy.
 * The kernel drops the lock if the holder dies, so a crashed install never wedges the file.
 */
export async function withFileLock<T>(
  path: string,
  options: { waitMs: number; signal?: AbortSignal; onWait?: () => void },
  body: () => Promise<T>,
): Promise<T> {
  const fd = openSync(path, "a+", 0o600);
  try {
    const deadline = Date.now() + options.waitMs;
    let waited = false;
    while (flock(fd, LOCK_EX | LOCK_NB) !== 0) {
      options.signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new LockWaitTimeoutError("lock wait timed out");
      if (!waited) {
        waited = true;
        options.onWait?.();
      }
      await delay(50, undefined, options.signal ? { signal: options.signal } : undefined);
    }
    try {
      return await body();
    } finally {
      flock(fd, LOCK_UN);
    }
  } finally {
    closeSync(fd);
  }
}

function flock(fd: number, operation: number): number {
  return libcFlock()(fd, operation);
}

function libcFlock(): Flock {
  if (flockFn !== null) return flockFn;
  const lib = dlopen(libcName(), {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  flockFn = (fd, operation) => lib.symbols.flock(fd, operation);
  return flockFn;
}

function libcName(): string {
  if (process.platform === "darwin") return "libSystem.B.dylib";
  if (process.platform === "linux") return "libc.so.6";
  throw new Error(`runtime install lock is unsupported on ${process.platform}`);
}
