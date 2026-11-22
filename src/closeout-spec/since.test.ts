import { expect, test } from "bun:test";
import { coversAnyPath, isSinceArgv, withSince } from "./since";
import type { ResolvedRequirement } from "./types";

const F = "f".repeat(40);
const items: ResolvedRequirement[] = [
  {
    id: "test",
    kind: "command",
    gate: "beforePR",
    exec: ["bun", "scripts/affected-tests.ts"],
    since: ["bun", "scripts/affected-tests.ts", "{since}"],
    timeoutSeconds: 60,
  },
  {
    id: "lint",
    kind: "command",
    gate: "beforePR",
    exec: ["bun", "run", "lint"],
    timeoutSeconds: 60,
  },
];

test("withSince swaps in the since argv only for the listed commands that have one", () => {
  const swapped = withSince({ items }, { head: F, ids: ["test", "lint"] }).items;
  expect(swapped.map((item) => ("exec" in item ? item.exec : []))).toEqual([
    ["bun", "scripts/affected-tests.ts", F],
    ["bun", "run", "lint"],
  ]);
  expect(withSince({ items }, { head: "main", ids: ["test"] }).items).toBe(items);
  expect(withSince({ items }, undefined).items).toBe(items);
});

test("isSinceArgv accepts the since argv with a commit in place of {since}", () => {
  const since = ["bun", "scripts/affected-tests.ts", "{since}"];
  expect(isSinceArgv(["bun", "scripts/affected-tests.ts", F], since)).toBe(true);
  expect(isSinceArgv(["bun", "scripts/affected-tests.ts", "origin/main"], since)).toBe(false);
  expect(isSinceArgv(["bun", "scripts/affected-tests.ts"], since)).toBe(false);
  expect(isSinceArgv(["bun", "scripts/affected-tests.ts", F], undefined)).toBe(false);
});

test("coversAnyPath follows paths and except", () => {
  expect(coversAnyPath({}, ["README.md"])).toBe(true);
  expect(coversAnyPath({}, [])).toBe(false);
  expect(coversAnyPath({ paths: ["src/loop/**"] }, ["docs/a.md"])).toBe(false);
  expect(coversAnyPath({ paths: ["src/**"], except: ["**/*.md"] }, ["src/a.md"])).toBe(false);
  expect(coversAnyPath({ paths: ["src/**"] }, ["src/a.ts"])).toBe(true);
});
