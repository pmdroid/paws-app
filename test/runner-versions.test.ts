import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as versions from "../src/runner-protocol/versions";
import {
  latestRelease,
  newSinceRelease,
  releasedVersions,
  versionsAbove,
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

const RELEASED = `
export const ACME_OLD: RunnerVersion = [0, 1, 40];
export const ACME_SHIPPED: RunnerVersion = [0, 1, 61];
`;

test("the latest release is the highest vmajor.minor.patch tag", () => {
  expect(latestRelease(["v0.1.9", "v0.1.61", "v0.1.10", "nightly", "v0.1.60"])).toBe("v0.1.61");
  expect(latestRelease(["nightly"])).toBeUndefined();
});

test("a released versions file reads as name to version", () => {
  expect(releasedVersions(RELEASED)).toEqual({
    ACME_OLD: "0.1.40",
    ACME_SHIPPED: "0.1.61",
  });
});

test("a minimum added after a release must name a later release", () => {
  const released = releasedVersions(RELEASED);
  expect(
    newSinceRelease("v0.1.61", released, {
      ACME_OLD: [0, 1, 40],
      ACME_SHIPPED: [0, 1, 61],
      ACME_SLIPPED: [0, 1, 61],
      ACME_NEXT: [0, 1, 62],
    }),
  ).toEqual([{ name: "ACME_SLIPPED", version: "0.1.61" }]);
});

test("lowering a released minimum to an older release is a slip too", () => {
  expect(
    newSinceRelease("v0.1.61", releasedVersions(RELEASED), {
      ACME_OLD: [0, 1, 40],
      ACME_SHIPPED: [0, 1, 50],
    }),
  ).toEqual([{ name: "ACME_SHIPPED", version: "0.1.50" }]);
});

test("the current versions file has no minimum the latest release shipped without", () => {
  expect(newSinceRelease("v0.0.0", {})).toEqual([]);
});
