import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeWorkspaceRefresh } from "./local/workspace-refresh";

test("permission refreshes apply later invalidations and drain before shutdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-workspace-refresh-"));
  const failed: string[] = [];
  try {
    await probeWorkspaceRefresh(root, (name, passed) => {
      if (!passed) failed.push(name);
    });
    expect(failed).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
