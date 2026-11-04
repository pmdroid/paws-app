import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let tempRoot: string | null = null;

/** Where credentialed Git creates its per-call directories; `null` uses the system temp directory. */
export function useGitTempDirectory(root: string | null): void {
  tempRoot = root;
}

export function gitTempDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(tempRoot ?? tmpdir(), prefix));
}
