import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("the test script and CI kill child processes a test leaves behind", () => {
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
  expect(scripts.test).toContain("--no-orphans");
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const runs = ci.split("\n").filter((line) => line.includes("bun test"));
  expect(runs.length).toBeGreaterThan(0);
  for (const line of runs) expect(line).toContain("--no-orphans");
});
