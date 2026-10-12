import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeWorkspaceAuthorization } from "./local/workspace-authorization";

test("workspace and project authorization across production HTTP routes", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-workspace-authorization-"));
  const failed: string[] = [];
  try {
    await probeWorkspaceAuthorization(root, (name, passed) => {
      if (!passed) failed.push(name);
    });
    expect(failed).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
