import { test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeRunnerInputsClock } from "./local/runner-inputs-clock";

test("Runner input fixture claims real certificates when authority initialization crosses a clock second", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-input-clock-"));
  try {
    await probeRunnerInputsClock(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
