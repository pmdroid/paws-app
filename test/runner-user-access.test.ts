import { test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerUserAccess } from "./local/runner-user-access";

test("non-root remote agents use host files and commands while concurrent tasks keep independent repositories", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-user-access-"));
  try {
    await probeRunnerUserAccess(root);
  } finally {
    chmodSync(join(root, "source"), 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});
