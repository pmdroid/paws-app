import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "paws-"));
}
