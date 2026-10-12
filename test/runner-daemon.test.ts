import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRunnerDaemon } from "./local/runner-daemon";

test("Linux runner daemon pairs, persists commands and rotates certificates over actual TLS", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-daemon-proof-"));
  try {
    await probeRunnerDaemon(root, (_name, passed) => expect(passed).toBe(true));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
