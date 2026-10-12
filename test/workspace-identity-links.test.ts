import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeWorkspaceIdentityLinks } from "./local/workspace-identity-links";

test("workspace Slack email matching and audited manual identity links", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-workspace-links-"));
  const failures: string[] = [];
  try {
    await probeWorkspaceIdentityLinks(root, (name, passed) => {
      if (!passed) failures.push(name);
    });
    expect(failures).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
