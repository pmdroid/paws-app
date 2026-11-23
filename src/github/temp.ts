import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hostOperationOwner } from "../host-operation";

let tempRoot: string | null = null;

/** Where credentialed Git creates its per-call directories; `null` uses the system temp directory. */
export function useGitTempDirectory(root: string | null): void {
  tempRoot = root;
}

export function gitTempDirectory(prefix: string): Promise<string> {
  const owner = hostOperationOwner();
  const named = owner !== undefined && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(owner);
  return mkdtemp(path.join(tempRoot ?? tmpdir(), named ? `${prefix}${owner}-` : prefix));
}
