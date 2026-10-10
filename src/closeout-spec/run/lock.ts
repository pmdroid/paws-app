import { dlopen, FFIType } from "bun:ffi";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

type Flock = (fd: number, operation: number) => number;

let flockFn: Flock | null = null;

/**
 * Hold an exclusive advisory lock on `<evidenceDir>/retry.lock` while `body`
 * runs. Attempts against the same evidence directory wait their turn.
 * The lock is per open file descriptor and is released when this process
 * exits. A policy with no `retry` does not take the lock.
 */
export async function withRetryLock<T>(
  evidenceDir: string,
  enabled: boolean,
  body: () => Promise<T>,
): Promise<T> {
  if (!enabled) return body();
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const fd = openSync(join(evidenceDir, "retry.lock"), "a+", 0o600);
  try {
    await acquire(fd);
    return await body();
  } finally {
    flock(fd, LOCK_UN);
    closeSync(fd);
  }
}

async function acquire(fd: number): Promise<void> {
  for (;;) {
    if (flock(fd, LOCK_EX | LOCK_NB) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function flock(fd: number, operation: number): number {
  return libcFlock()(fd, operation);
}

function libcFlock(): Flock {
  if (flockFn !== null) return flockFn;
  const lib = dlopen(libcName(), {
    flock: {
      args: [FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
  });
  flockFn = (fd, operation) => lib.symbols.flock(fd, operation);
  return flockFn;
}

function libcName(): string {
  if (process.platform === "darwin") return "libSystem.B.dylib";
  if (process.platform === "linux") return "libc.so.6";
  throw new Error(`retry lock is unsupported on ${process.platform}`);
}
