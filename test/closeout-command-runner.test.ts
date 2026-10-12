import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeCloseoutCommandRunner } from "./local/closeout-command-runner";

test("native Closeout retains policy and evidence authority with injected command execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-closeout-command-runner-"));
  let observed = 0;
  try {
    await probeCloseoutCommandRunner(root, (_name, passed) => {
      expect(passed).toBe(true);
      observed++;
    });
    expect(observed).toBe(6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
