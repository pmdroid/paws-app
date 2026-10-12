import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeWorkspaceBrowser } from "./local/workspace-browser";

test("browser OAuth, paginated membership, session identity and revocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-workspace-browser-"));
  const failed: string[] = [];
  try {
    await probeWorkspaceBrowser(root, (name, passed) => {
      if (!passed) failed.push(name);
    });
    expect(failed).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
