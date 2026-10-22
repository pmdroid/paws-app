import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeWorkspaceLinearActions } from "./local/workspace-linear-actions";

test("Linear human actions honor verified workspace roles and team membership", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-workspace-linear-actions-"));
  const failures: string[] = [];
  try {
    await probeWorkspaceLinearActions(root, (name, passed) => {
      if (!passed) failures.push(name);
    });
    expect(failures).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
