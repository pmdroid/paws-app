import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetPath } from "../src/assets";

test("assets resolve from the checkout", () => {
  expect(JSON.parse(readFileSync(assetPath("package.json"), "utf8")).name).toBe("paws");
});
test("embedded assets extract privately and reuse their files", () => {
  const home = mkdtempSync(join(tmpdir(), "paws-assets-"));
  try {
    const source = join(home, "input");
    writeFileSync(source, "embedded data");
    const manifest = { "nested/data": source };
    const path = assetPath("nested/data", manifest, home);
    expect(readFileSync(path, "utf8")).toBe("embedded data");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(assetPath("nested/data", manifest, home)).toBe(path);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
