import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probeWorkspaceLinearDirect,
  probeWorkspaceLinearHttps,
} from "./local/workspace-linear-actions";

async function failures(probe: typeof probeWorkspaceLinearDirect) {
  const root = mkdtempSync(join(tmpdir(), "paws-workspace-linear-actions-"));
  const failed: string[] = [];
  const passed: string[] = [];
  try {
    await probe(root, (name, ok) => (ok ? passed : failed).push(name));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return { failed, passed: passed.length };
}

test("Linear human actions honor verified workspace roles and team membership", async () => {
  const { failed, passed } = await failures(probeWorkspaceLinearDirect);
  expect(failed).toEqual([]);
  expect(passed).toBe(15);
}, 20_000);

test("Linear human actions over local HTTPS honor workspace roles and team membership", async () => {
  const { failed, passed } = await failures(probeWorkspaceLinearHttps);
  expect(failed).toEqual([]);
  expect(passed).toBe(6);
}, 20_000);
