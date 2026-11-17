import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as versions from "../src/runner-protocol/versions";
import {
  latestRelease,
  minimumAboveRelease,
  minimumLowered,
  releaseBelowMinimum,
  releasedMinimum,
} from "../scripts/check-runner-versions";

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

test("a release below the minimum fails; an equal or higher release passes", () => {
  expect(releaseBelowMinimum("0.1.84", [0, 1, 84])).toBe(false);
  expect(releaseBelowMinimum("0.1.85", [0, 1, 84])).toBe(false);
  expect(releaseBelowMinimum("0.2.0", [0, 1, 84])).toBe(false);
  expect(releaseBelowMinimum("1.0.0", [0, 1, 84])).toBe(false);
  expect(releaseBelowMinimum("0.1.83", [0, 1, 84])).toBe(true);
  expect(() => releaseBelowMinimum("v0.1.47")).toThrow();
});

test("the latest release is the highest vmajor.minor.patch tag", () => {
  expect(latestRelease(["v0.1.9", "v0.1.61", "v0.1.10", "nightly", "v0.1.60"])).toBe("v0.1.61");
  expect(latestRelease(["nightly"])).toBeUndefined();
});

test("a released versions file reads its minimum runner version", () => {
  expect(
    releasedMinimum(
      ["OLD_RUNNER_VERSION", "MINIMUM_RUNNER_VERSION"]
        .map((name, patch) => `export const ${name}: RunnerVersion = [0, 1, ${patch + 83}];`)
        .join("\n"),
    ),
  ).toEqual([0, 1, 84]);
  expect(releasedMinimum("")).toBeUndefined();
});

test("the minimum runner version must name a runner that has shipped", () => {
  expect(minimumAboveRelease("v0.1.84", [0, 1, 84])).toBe(false);
  expect(minimumAboveRelease("v0.1.86", [0, 1, 84])).toBe(false);
  expect(minimumAboveRelease("v0.1.83", [0, 1, 84])).toBe(true);
});

test("lowering a released minimum runner version is a slip", () => {
  expect(minimumLowered([0, 1, 84], [0, 1, 84])).toBe(false);
  expect(minimumLowered([0, 1, 84], [0, 1, 86])).toBe(false);
  expect(minimumLowered([0, 1, 84], [0, 1, 50])).toBe(true);
  expect(minimumLowered(undefined, [0, 1, 84])).toBe(false);
});
