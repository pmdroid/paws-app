import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as versions from "../src/runner-protocol/versions";
import { versionsAbove } from "../scripts/check-runner-versions";

const ROOT = new URL("../", import.meta.url).pathname;

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (name === "node_modules" || name === "dist") return [];
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}

test("every minimum runner version is a [major, minor, patch] of non-negative integers", () => {
  const entries = Object.entries(versions);
  expect(entries.length).toBeGreaterThan(0);
  for (const [name, version] of entries) {
    expect(name).toMatch(/^[A-Z][A-Z0-9_]*_RUNNER_VERSION$/);
    expect(version).toHaveLength(3);
    for (const part of version) expect(Number.isSafeInteger(part) && part >= 0).toBe(true);
  }
});

test("src/runner-protocol/versions.ts is the only place a minimum runner version is declared", () => {
  const declared = ["src", "scripts", "test"]
    .flatMap((directory) => files(join(ROOT, directory)))
    .filter((path) => /_RUNNER_VERSION(?::[^=]+)?\s*=\s*\[/.test(readFileSync(path, "utf8")))
    .map((path) => relative(ROOT, path));
  expect(declared).toEqual(["src/runner-protocol/versions.ts"]);
});

test("a release below a constant names it; an equal or higher release passes", () => {
  for (const [name, minimum] of Object.entries(versions)) {
    const [major, minor, patch] = minimum;
    const names = (release: number[]) =>
      versionsAbove(release.join(".")).map((above) => above.name);
    expect(names(minimum as unknown as number[])).not.toContain(name);
    expect(names([major, minor, patch + 1])).not.toContain(name);
    expect(names([major, minor + 1, 0])).not.toContain(name);
    expect(names([major + 1, 0, 0])).not.toContain(name);
    if (patch > 0)
      expect(versionsAbove([major, minor, patch - 1].join("."))).toContainEqual({
        name,
        version: minimum.join("."),
      });
  }
  expect(() => versionsAbove("v0.1.47")).toThrow();
});
