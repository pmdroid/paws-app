import { accessSync, constants, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MEMORY = "/dev/shm";

function memoryBacked(): string | undefined {
  try {
    if (!statSync(MEMORY).isDirectory()) return undefined;
    accessSync(MEMORY, constants.W_OK | constants.X_OK);
    return MEMORY;
  } catch {
    return undefined;
  }
}

export function scratchDirectory(prefix: string): string {
  return mkdtempSync(join(memoryBacked() ?? tmpdir(), prefix));
}
