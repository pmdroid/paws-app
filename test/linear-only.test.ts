import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntime } from "../src/config";

const homes: string[] = [];
function home() {
  const dir = mkdtempSync(join(tmpdir(), "paws-linear-only-"));
  homes.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("Linear config keeps GitHub App auth", () => {
  const dir = home();
  writeFileSync(join(dir, "config.toml"), `[tracker]\nkind = "linear"\n[github]\nauth = "app"\n`);
  const runtime = loadRuntime({ PAWS_HOME: dir });
  expect(runtime.configError).toBeNull();
  expect(runtime.trackerKind).toBe("linear");
  expect(runtime.githubAuth).toBe("app");
});
