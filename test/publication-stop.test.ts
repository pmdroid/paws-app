import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { probePublicationStop } from "./local/publication-stop";

test("stopped PR cleanup survives restart and publication waits for authoritative refresh", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-publication-stop-"));
  const names: string[] = [];
  try {
    await probePublicationStop(root, (name, passed) => {
      assert(passed, name);
      names.push(name);
    });
    assert.equal(names.length, 18);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
