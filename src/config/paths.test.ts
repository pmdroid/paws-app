import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLayout, pawsPaths } from "./paths";
import { useMemorySettings } from "./settings-store";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test("the layout creates tmpDir with mode 0700", () => {
  const home = mkdtempSync(join(tmpdir(), "paws-home-"));
  homes.push(home);
  const paths = pawsPaths(home);
  ensureLayout(paths);
  expect(paths.tmpDir).toBe(join(home, "tmp"));
  expect(statSync(paths.tmpDir).mode & 0o777).toBe(0o700);
});

test("mirrors turned off in Settings leave repos absent at startup", () => {
  const home = mkdtempSync(join(tmpdir(), "paws-home-"));
  homes.push(home);
  const paths = pawsPaths(home);
  useMemorySettings(paths.configFile, "[github_access]\nmirrors = false\n");
  ensureLayout(paths);
  expect(existsSync(paths.reposDir)).toBe(false);
});
