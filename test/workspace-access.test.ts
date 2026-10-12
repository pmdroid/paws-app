import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeWorkspaceAccess } from "./local/workspace-access";

test("workspace bootstrap, session persistence, expiry and membership lifecycle", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-workspace-access-"));
  const failed: string[] = [];
  try {
    await probeWorkspaceAccess(root, (name, passed) => {
      if (!passed) failed.push(name);
    });
    expect(failed).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
