import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeWorkspaceRuntime } from "./local/workspace-runtime";

test("public workspace startup and membership refresh shutdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-workspace-runtime-"));
  const failed: string[] = [];
  try {
    await probeWorkspaceRuntime(root, (name, passed, observed) => {
      if (!passed) { failed.push(name); console.error("OBSERVED", name, JSON.stringify(observed)); }
    });
    expect(failed).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
