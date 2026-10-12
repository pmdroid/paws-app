import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probePublicTlsRenewal } from "./local/public-tls-renewal";

test("public TLS validation retains live identity and normal CLI joins restart shutdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-public-tls-renewal-"));
  try {
    await probePublicTlsRenewal(root, (name, passed) => assert(passed, name));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
